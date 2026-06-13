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
last-reviewed: 2026-06-12
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

**Why guests never get OSN accounts:** the guest journey is "tap a link at the dinner table, pick who's coming". Any registration ceremony — even a passkey one — would lose RSVPs. The claim code is deliberately low-friction and family-scoped; the security bar is "unguessable + rate-limited + revocable", not "authenticated identity". A future optional claim-code → OSN account link is tracked in `wiki/TODO.md` (Cire section), but it must stay optional.

## Organiser path: OSN passkey → access JWT → wedding ownership

Organisers sign in on the organiser portal (`@cire/organiser`, :4322) using the standard OSN `<SignIn>` component from `@osn/ui` driven by `@osn/client` — a normal OSN passkey ceremony against the OSN issuer (`@osn/api`, :4000). Cire adds no login surface of its own.

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

The two middlewares never run on the same route. `sessionAuth()` gates guest routes (`/api/rsvp`); `osnAuth()` (+ ownership middleware) gates `/api/organiser/*`. There is no route that accepts either credential, no privilege ladder from guest session to organiser, and no shared token format — a leaked guest cookie can never reach organiser surface and an organiser JWT is meaningless on the RSVP endpoint. The interim `X-Organiser-Token` shared secret that predated this model is fully deleted.

## Related

- [[identity-model]] — OSN accounts, profiles, access-token contract
- [[passkey-primary]] — the passkey-only login organisers use
- [[sessions]] — OSN's server-side session store (the refresh cookie behind `authFetch`)
- [[cire]] — app overview, packages, data model
- [[data-map]] — cire personal-data fields (the `public_id` claim code is a credential; `cire_session` redacted in logs)
- [[access-control]] — cire D1/R2 operator access + these two credential classes in the access matrix
