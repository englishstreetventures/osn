---
title: Cire two-system auth
tags: [systems, auth, security, weddings]
related:
  - "[[identity-model]]"
  - "[[passkey-primary]]"
  - "[[sessions]]"
  - "[[cire]]"
  - "[[data-map]]"
  - "[[access-control]]"
  - "[[arc-tokens]]"
last-reviewed: 2026-06-15
---

# Cire two-system auth

Cire runs **two deliberately separate auth systems** that never overlap. Guests are wedding attendees who must not be asked to create accounts; organisers are OSN users who own a wedding. The systems differ in credential, storage, transport, and threat model — do not try to unify them.

| | Guests | Organisers |
|---|---|---|
| Credential | Family claim code (`families.public_id`) | OSN passkey ([[passkey-primary]]) |
| Token | Opaque 256-bit session token | ES256 access JWT, `aud: "osn-access"`, 5-min TTL |
| Storage at rest | SHA-256 hash in cire's `sessions` table | Nothing in cire — verification is stateless via JWKS |
| Transport | `cire_session` HttpOnly cookie (30 days) | `Authorization: Bearer` via `@osn/client` `authFetch` |
| Middleware | `sessionAuth()` (`cire/api/src/middleware/auth.ts`) | `osnAuth()` + `weddingOwner()` / `ownedWedding()` |
| Routes | `/api/rsvp` | `/api/organiser/*` |

## Guest path: claim code → session cookie

1. A family receives a shareable claim code — `families.public_id`, e.g. `SHARMA-IVY-QM42` (family name + word + 4-char hash; collisions on family name are fine, the word/hash disambiguates).
2. `POST /api/claim` looks up the code and mints a 256-bit random session token. The token is stored **SHA-256-hashed** in cire's `sessions` table (DB read never yields a usable credential); the raw value goes only into the cookie.
3. Cookie attributes: `cire_session`, `HttpOnly; SameSite=Lax; Path=/`, 30-day TTL, host-scoped (no `Domain=` until a production root domain lands). CORS echoes the configured origin with `credentials: true`.
4. `sessionAuth()` (an Elysia plugin) gates `/api/rsvp`: parses the cookie, validates the hash against `sessions`, and derives `familyId` for downstream handlers. Any failure is a generic 401 `Unauthorized` — no session-state leakage.
5. `POST /api/claim` is rate-limited (KV-backed, via `@shared/rate-limit`) to keep code brute-force impractical.

**Why guests never get OSN accounts:** the guest journey is "tap a link at the dinner table, pick who's coming". Any registration ceremony — even a passkey one — would lose RSVPs. The claim code is deliberately low-friction and family-scoped; the security bar is "unguessable + rate-limited + revocable", not "authenticated identity". Guests may **optionally** link an OSN account on top of the guest session — see [Guest account linking](#guest-account-linking-the-one-deliberate-dual-credential-route) — but the claim-code session stays the primary credential.

## Organiser path: OSN passkey → access JWT → wedding ownership

Organisers sign in on the organiser portal (`@cire/organiser`, :4322) using the standard OSN `<SignIn>` component from `@osn/ui` driven by `@osn/client` — a normal OSN passkey ceremony against the OSN issuer (`@osn/api`, :4000). Cire adds no login surface of its own.

Organisers who don't yet have an OSN account can create one from the same page: `SignInPanel` toggles between `<SignIn>` and the `<Register>` component (also from `@osn/ui`, driven by `@osn/client`'s registration client), so the email-OTP + first-passkey ceremony runs against the OSN issuer just like sign-in. The account is created on OSN, not cire — cire still owns no identity store. A freshly-registered account is signed in immediately (the `<Register>` `onSuccess` callback redirects to the dashboard), so it flows into the same access-JWT verification chain below.

### Verification chain (request → claims)

```
@osn/client authFetch                 attaches Bearer <access JWT>; silent-refreshes on 401
  └─▶ cire/api osnAuth()              thin wrapper over @shared/osn-auth-client (Elysia adapter)
        ├─▶ extractClaims()           verifies ES256 signature + exp against the issuer key
        │     └─▶ JWKS cache          resolves kid → CryptoKey from /.well-known/jwks.json
        │                             (LRU, 256 entries, 5-min TTL; cache key includes the
        │                             JWKS URL so multi-issuer kids never collide; one
        │                             cache-bypass retry on verify failure for key rotation)
        └─▶ tokenMatchesAudience()    pins aud === "osn-access" (extractClaims doesn't check aud)
              └─▶ c.var.osnProfileId = sub
```

`osnAuth()` is mounted on `/api/organiser/*`. It only authenticates — it says "this is OSN profile `usr_…`", nothing about which wedding they may touch.

### Authorization: wedding ownership

`weddings.owner_osn_profile_id` stores the owning OSN profile id as an **opaque string** — no cross-DB FK (cire's D1 and OSN's DB are separate databases; the id is a foreign-system reference, not a relation). Two middlewares enforce it:

- **`weddingOwner()`** — for `/api/organiser/weddings/:weddingId/*`. Loads the wedding row: unknown wedding → **404** `wedding_not_found` (don't disclose existence), owner mismatch → **403** `forbidden`. Sets `c.var.weddingId`.
- **`ownedWedding()`** — for organiser routes with no `:weddingId` param (the import routes). Derives the caller's single owned wedding: zero owned → **404** `no_weddings`; more than one → **400** `multiple_weddings` with a hint to use the explicit wedding-scoped routes.

### Error-code design: 403 vs 401 (real bug class)

`authFetch` in `@osn/client` treats **401 as "access token expired"**: it silently refreshes from the HttpOnly session cookie and retries; if refresh fails it drops the session and the UI bounces to sign-in. So an *authenticated-but-forbidden* caller (valid JWT, not the wedding owner) **must get 403, never 401** — a 401 here would make the client discard a perfectly valid OSN session and log the organiser out for an authorization problem. We hit this during the merge; the middlewares are written around it:

- 401 → only from `osnAuth()` (missing/invalid/expired token) — i.e. "re-authenticate".
- 403 → authenticated, not authorized (`weddingOwner()` owner mismatch) — "you can't touch this".
- 404 → resource existence not disclosed (unknown wedding, no owned weddings).
- 400 → ambiguous request shape (`multiple_weddings`).

Related debt: `@osn/client` should export an `isAuthExpiredError()` helper — `cire/organiser/src/lib/api.ts` currently string-matches `"AuthExpiredError"` because Effect's FiberFailure wrapping defeats `instanceof`. Tracked in `wiki/TODO.md` Platform.

## No overlap

The two middlewares never run on the same route **except the account-link POST below**, and even there they are not a privilege ladder. `sessionAuth()` gates guest routes (`/api/rsvp`); `osnAuth()` (+ ownership middleware) gates `/api/organiser/*`. Outside the linking POST there is no route that accepts either credential, no privilege ladder from guest session to organiser, and no shared token format — a leaked guest cookie can never reach organiser surface and an organiser JWT is meaningless on the RSVP endpoint. The interim `X-Organiser-Token` shared secret that predated this model is fully deleted.

## Guest account linking (the one deliberate dual-credential route)

An invitee may **optionally** attach their seat to a real OSN/Pulse account so they can see the invitation inside Pulse, and — within a family group — see other invitees' latest RSVPs. This is the **only** surface that requires both credentials at once, and it is **additive, not a ladder**: the OSN token grants no cire authority; it only names *which OSN account* to staple onto a household the guest session has already proven.

| | |
|---|---|
| Endpoints | `POST /api/account/link` (dual-credential), `GET /api/account/link`, `DELETE /api/account/link/:guestId` (guest-only) |
| Middleware | `sessionAuth()` (Elysia plugin) on all methods; `osnAuth()` **method-gated to POST** by mounting it on a sibling Elysia instance — `createAccountLinkPostRoute` (POST, sessionAuth + osnAuth) and `createAccountLinkRoutes` (GET/DELETE, sessionAuth only) share the prefix but not the OSN gate, the same sibling-instance pattern that keeps `/api/rsvp` ungated by the organiser `osnAuth` |
| Table | `guest_account_links` (`@cire/db`) — **per invitee** (`guests` row), not per family |
| Stored id | `osn_account_id` (account-level, so any of the user's OSN profiles can see the invitation) + `osn_profile_id` (audit). Opaque cross-DB references, no FK — same rule as `weddings.owner_osn_profile_id`. |

**The bind.** `POST /api/account/link` carries `{ guestId }`. `sessionAuth()` proves the household (`familyId`); the `guestId` must belong to that family (else **403**). `osnAuth()` proves the OSN identity (`osnProfileId = sub`). The profile is resolved to its **account id** server-to-server over [[arc-tokens|ARC]] (`GET /graph/internal/profile-account`, `graph:read`) — account id is S2S-only and never returned to the client. The link row staples `guestId → osn_account_id`.

**Uniqueness.** One link per invitee (`guest_id` unique); one OSN account can't claim two seats in the same household (`(family_id, osn_account_id)` unique); the *same* account linking across different weddings is allowed (one person, many invitations). Conflicts → generic **409 `already_linked`** (no enumeration).

**401 here is correct (no 403 hazard).** Unlike the organiser 403-vs-401 rule above, a **401 from `osnAuth()` on the link POST is the right answer**: the guest's Pulse access token genuinely expired and `@osn/client` should silently refresh and retry. There's no authz wall to mask — the guest is *re-authenticating to OSN*, not being denied a cire resource. `GET`/`DELETE` never invoke `osnAuth()` (a guest with an expired Pulse token can still read/remove their household's links), so they can't trip it.

**ARC on Workers.** cire/api runs on workerd, so it mints the outbound ARC token via the DB-free, metric-free `@shared/crypto/jwk` `signArcToken` (the barrel `@shared/crypto` and `@shared/observability` don't bundle for workerd). Key distribution is a **stable** ES256 key (`CIRE_API_ARC_PRIVATE_KEY` wrangler secret) pre-registered in osn-api's `service_accounts` under serviceId `cire-api` — not the ephemeral-key self-registration + rotation that long-lived bun services use, because a Worker has no startup hook. When the ARC key is absent the POST answers **503** (linking is opt-in; the rest of cire is unaffected). The resolver is injectable (`createApp({ resolveOsnAccountId })`) so tests stub it.

The browser-side affordance (a "link my Pulse account" button on the guest site that obtains an OSN access token and POSTs it with the guest cookie) is **deferred** — backend only for now.

## Related

- [[identity-model]] — OSN accounts, profiles, access-token contract
- [[passkey-primary]] — the passkey-only login organisers use
- [[sessions]] — OSN's server-side session store (the refresh cookie behind `authFetch`)
- [[cire]] — app overview, packages, data model
- [[data-map]] — cire personal-data fields (the `public_id` claim code is a credential; `cire_session` redacted in logs)
- [[access-control]] — cire D1/R2 operator access + these two credential classes in the access matrix
