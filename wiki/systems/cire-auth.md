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
  - "[[oidc-provider]]"
  - "[[musubi-identity-migration]]"
last-reviewed: 2026-08-02
---

# Cire auth model

Cire runs **three deliberately separate auth principal classes**. Guests are wedding attendees, and cire must never ask them to create an account; organisers are OSN users who own a wedding; vendors are OSN users who also hold membership in an OSN org. The systems differ in credential, storage, transport, and threat model — do not try to unify them.

| | Guests | Organisers | Vendors |
|---|---|---|---|
| Credential | Family claim code (`families.public_id`) | OSN passkey ([[passkey-primary]]), spent on `musubi.social` and carried back by [[oidc-provider\|OIDC]] | Same, plus OSN org membership |
| Token | Opaque 256-bit session token | Opaque 256-bit session token, minted by cire-api after the code exchange | Same session token; org membership resolved over ARC (`org:read`) |
| Storage at rest | SHA-256 hash in cire's `sessions` table | SHA-256 hash in cire's `organiser_sessions` table | Same |
| Transport | `cire_session` HttpOnly cookie (30 days) | `cire_org_session` HttpOnly cookie (7 days) via `@shared/rp-auth` `authFetch` | Same cookie transport |
| Middleware | `sessionAuth()` (`cire/api/src/middleware/auth.ts`) | `osnAuth()` + `weddingOwner()` / `weddingEditor()` / `weddingMember()` | `osnAuth()` + `vendorOrgMember()` |
| Routes | `/api/rsvp`, `GET /api/claim/session` | `/api/organiser/*` | `/api/vendor/*` |

`osnAuth()` still accepts an `Authorization: Bearer` OSN access token as a second way in, for callers that are not a cire browser — a first-party OSN surface holding a live `aud: "osn-access"` token, and the route tests. No browser uses it any more.

## Vendor principal — the third principal class (Phase 2)

Vendors are **OSN account holders who are members of an OSN organisation (`org_*`)**. The vendor's org is the unit of identity in cire's directory — one directory listing per org (`directory_vendors.org_id UNIQUE`). A vendor with multiple brands uses separate OSN orgs.

`vendorOrgMember()` (`cire/api/src/middleware/vendor-org-member.ts`) gates `/api/vendor/*`. It runs `osnAuth()` (session cookie or access token, sets `c.var.osnProfileId`) and then makes an ARC-gated call to `@osn/api` `GET /organisations/internal/membership?orgId=&profileId=` (**scope `org:read`**) to confirm the caller's OSN profile is an active member of the target org. On success it sets `c.var.vendorOrgId` + `c.var.directoryVendorId`. On ARC failure it fails-soft to **503** (never a bypass). An authenticated-but-non-member caller gets **403**.

The `org:read` scope is the ARC bridge that connects cire-api to osn-api's org-membership resolver. cire-api's ARC key registration (`POST /graph/internal/register-service`) must list `org:read` alongside `graph:read` and `graph:resolve-account` — see [[production-deploy]] §6.2 and the [[arc-tokens]] pattern. Until the widened registration runs **per environment** (after the `@osn/api` `PERMITTED_SCOPES` change deploys), `vendorOrgMember()` fails-soft to null and org-gated vendor writes return **503** — the organiser CRM and claim-link generation work regardless.

**The org list is proxied, not read direct.** `GET /api/vendor/orgs` returns the caller's OSN organisations over the same `org:read` ARC bridge (`GET /organisations/internal/profile-orgs?profileId=`, whole summaries — id, handle, name, avatar — not bare ids). Before the OIDC swap the portal called osn-api itself with the user's access token; it now holds a cire session cookie, which osn-api will not accept, so cire-api is the only path. Gated by `osnAuth()` alone and scoped by construction (the resolver keys on the profile id from the verified session), and fail-soft: an ARC hiccup resolves to an empty list, which the portal renders as "no organisations yet".

See [[systems/vendors]] (cire wiki) for the full vendor principal model, the four new tables, and the email-verification claim flow.

## Guest path: claim code → session cookie

1. A family receives a shareable claim code — `families.public_id`, format **`SURNAME-WORD-HASH`** (see [Claim-code format](#claim-code-format-c1) below), e.g. `SHARMA-WIDGET-AB3K9-X7QPM`. Surname collisions are fine; the random word + hash carry the entropy.
2. `POST /api/claim` looks up the code (case-insensitive — input is upper-cased before lookup) and mints a 256-bit random session token. The token is stored **SHA-256-hashed** in cire's `sessions` table (DB read never yields a usable credential); the raw value goes only into the cookie.
3. Cookie attributes: `cire_session`, `HttpOnly; SameSite=Lax; Path=/`, 30-day TTL, host-scoped (no `Domain=` until a production root domain lands). CORS echoes the configured origin with `credentials: true`.
4. `sessionAuth()` (an Elysia plugin) gates `/api/rsvp` and `GET /api/claim/session`: parses the cookie, validates the hash against `sessions`, and derives `familyId` for downstream handlers. Any failure is a generic 401 `Unauthorized` — no session-state leakage.
5. `GET /api/claim/session?slug=<wedding>` **restores** an invite for a household that already claimed, returning exactly what `POST /api/claim` returns. It is not a second door in: it accepts no claim code, the caller cannot name a family, and the id comes only from the cookie — so it can be read as "what is MY invite for this wedding", never "whose invite is this". **The slug is required** (400 without it) and checked with `inviteService.sessionOwnsWedding`: the guest site serves every wedding from one origin while `cire_session` names one family and therefore one wedding, so an unscoped restore would paint wedding A's events into wedding B's shell — and because `POST /api/rsvp` keys on the cookie's `familyId` with event ids from the body, an RSVP sent from that state would write to A's events while the guest believed they answered B's. A wrong-wedding request answers the same generic 401 but deliberately does NOT clear the cookie: that session is valid, just not here, and clearing it would sign a guest out of their own invite for opening someone else's link. The response is `Cache-Control: no-store` + `Vary: Origin, Cookie` — the body is selected entirely by the cookie and carries Art. 9 dietary text, so no shared cache may retain or replay it (set in a hook ahead of `sessionAuth`, so the plugin's own 401 carries them too). It re-checks `families.deactivated_at` as defence in depth — `familyDeactivate` already revokes the family's live sessions in the same commit, so this is the belt to that braces rather than a hole being closed — and **clears the cookie** on that 401 rather than leaving a household retrying a dead one. No first-open write: a restore is by definition not first contact. Both entry points build their payload through one shared `buildClaimResponse`, so the events list and the S-H1-gated closing section can never differ between them.
   It is a **sibling Elysia instance** to the claim route, not another method on it, because a scoped limiter applies per instance: the restore is hit on every invite page load and must not draw on the claim endpoint's brute-force budget (5/min) — it has its own, 60/min, mirroring `oidcSessionLimiter`. The same read/write split as the organiser hosts routes.
   The guest site calls it client-side on island mount, gated on a **non-credential** `cire_claimed` hint cookie written on a successful claim — without it every first-time visitor and link-preview crawler would spend an account-wide Workers invocation (100k/day, shared with osn-api) to be told 401. The hint carries no authority: forging it buys exactly the 401 it would have got anyway. It is **not** during SSR: `cire_session` is host-scoped to `api.cireweddings.com`, so the guest-site Worker never receives it and cannot forward it while rendering. Painting a restored invite into the first HTML byte would require widening the cookie's `Domain=`, which the audit in `cire/api/src/lib/cookie.ts` deliberately rules out.
6. `POST /api/claim` is rate-limited to keep code brute-force impractical. The limiter is the **native Cloudflare Workers Rate Limiting binding** (`CLAIM_RATE_LIMITER` in `wrangler.toml`) — a global, atomic, per-IP edge limiter — wrapped as a `RateLimiterBackend` by `WorkersRateLimiterBackend` (`cire/api/src/lib/workers-rate-limiter.ts`), fail-closed on a binding throw. The in-memory `@shared/rate-limit` limiter is the dev/test fallback when the binding is absent. (This corrects the earlier note that called it "KV-backed" — it was never KV; it is the native ratelimit binding.) IP keying is Cloudflare-only and **fails closed**: `getClientIp` keys strictly on `cf-connecting-ip` via `@shared/rate-limit`'s hardened helper (`trustCloudflare: true`) and denies (429) when the header is missing/malformed rather than bucketing on a spoofable fallback (C4).

### Claim-code format (C1)

`SURNAME-WORD-HASH`, minted by `cire/api/src/services/family-code.ts`:

- **SURNAME** — uppercased family surname, symbols stripped, capped. **Readability only / non-security** (surname collisions are expected); empty/symbol-only surnames degrade to `FAMILY`.
- **WORD** — one word drawn uniformly at random (CSPRNG, rejection-sampled, no modulo bias) from the **EFF short wordlist** (1296 words → ~10.34 bits), bundled as a frozen data module (`cire/api/src/data/eff-short-wordlist.ts`) so it ships in the Worker bundle with no I/O.
- **HASH** — Crockford base32 (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, excludes I/L/O/U; case-insensitive on entry), tier-driven length:

| Tier | Hash | Grouping | Hash entropy | Total code |
|---|---|---|---|---|
| `secure` (**default**) | 10 chars | 5-5 (`AB3K9-X7QPM`) | ~50 bits | ~60 bits |
| `simple` | 6 chars | ungrouped | ~30 bits | ~40 bits |

The tier lives in the **`weddings.code_style`** column (enum `simple | secure`, default `secure`; migration `0011_wedding_code_style.sql`). The CSV-import diff reads it once per import and mints every new family code at that tier. **Re-mint:** legacy `NAME-XXXXXXXX` codes on the live wedding are rotated to the new format by the idempotent, tenant-scoped operator function `scripts/remint-family-codes.ts` (re-mints only single-hyphen legacy codes; a second run is a no-op).

**Regenerating one family's code (C2):** `POST /api/organiser/weddings/:weddingId/families/:familyId/regenerate-code` (owner-gated by `weddingOwner()`, verifies family ∈ wedding) mints a fresh code on the wedding's tier and, **atomically in one D1 batch**, rotates `families.public_id` AND revokes every session for that family (`sessionService.revokeAllForFamily`) — so the old code and any session minted from it die in the same commit.

**Why guests never get OSN accounts:** the guest journey is "tap a link at the dinner table, pick who's coming". Any registration ceremony — even a passkey one — would lose RSVPs. The claim code is deliberately low-friction and family-scoped; the security bar is "unguessable + rate-limited + revocable", not "authenticated identity". Guests may **optionally** link an OSN account on top of the guest session — see [Guest account linking](#guest-account-linking-the-one-deliberate-dual-credential-route) — but the claim-code session stays the primary credential.

### Host preview code (organiser "Preview invite")

Every wedding can have **one synthetic host family** (`families.kind = 'host'`, enforced unique per wedding by the partial index `families_one_host_per_wedding`) whose claim code lets the organiser open the guest invite and see **every** event — there is no visibility flag or bypass in the read path, the host is just a real `families` row + one guest linked to all events, so `claimService.lookup` runs unchanged.

- **Provisioning** is member-gated (any role, including a viewer co-host — moved down from `weddingOwner` with the Phase 0 roles PR): `POST /api/organiser/weddings/:weddingId/preview-code` (behind `osnAuth` + `weddingMember`) calls `hostCodeService.ensureForWedding`, which idempotently find-or-creates the host family + its guest and (re-)links it to all current events. Previewing the invite is the *read* experience — it's the only way a co-host sees the invite as guests will — and the minted `HOST-*` code is the synthetic preview credential (RSVP-blocked below), not a guest claim code, so the owner-only code-management rule doesn't apply. Returns a `HOST-*` `public_id` (128-bit CSPRNG suffix via `crypto.getRandomValues` — well above the 112-bit credential bar and far stronger than the 32-bit family code, since it unlocks the whole wedding).
- **Preview-only.** The claim response carries `preview: true`; the guest web app shows a "Preview mode" banner and disables RSVP, and `POST /api/rsvp` rejects host-family sessions with **403** so the host code can never pollute real RSVP data.
- **Import-safe.** Host families are excluded from the spreadsheet-import diff (`kind != 'host'` on the family/guest/link scans), so a CSV re-import never removes or churns them. New events created by an import are picked up on the next preview-code call (the re-link step).
- The organiser dashboard's "Preview invite" button POSTs the endpoint, then opens the guest site (`PUBLIC_CIRE_WEB_URL`) at `?code=<host code>`, which the web app auto-claims on mount.

## Organiser path: OIDC redirect → cire session cookie → wedding ownership

**Why it changed (2026-07-27).** Identity moved to its own zone and the WebAuthn RP ID became `musubi.social` ([[musubi-identity-migration]]). A passkey ceremony may only run on an origin same-site with the RP ID, so `host.cireweddings.com` can no longer mint an OSN credential, and it cannot silent-refresh an access token either — OSN's session cookie is cross-site to it. The portal therefore stopped talking to the issuer at all. It sends the organiser to musubi to sign in, and cire-api takes it from there.

The shape is **backend-for-frontend**: cire-api is a registered OIDC relying party, it runs the code exchange server-side, and it hands the browser its *own* session cookie. The browser never holds an OSN token.

Cire still adds no login surface of its own, and still owns no identity store — an organiser without an OSN account creates one on musubi, at the end of the same redirect.

**Two doors, one journey (2026-07-28).** The login page offers *Continue with musubi* and *Create account with musubi*. Both leave for the same issuer and end in the same place, a signed-in organiser on the dashboard; the second only adds `prompt=create`, which asks the consent screen to open on its sign-up half. It earns its own button because someone here for the first time has no passkey to offer, and a screen demanding one is a dead end rather than an invitation. The page therefore does **not** redirect on mount any more — it did while there was nothing to choose. See [[oidc-provider]] for the `prompt` table and [[authorize-ui]] for the screen.

**Resuming instead of redirecting (2026-07-28).** In place of the old redirect, the login page asks `GET /api/auth/session` behind the rendered page — `resumeSession()` in `@shared/rp-auth`. A visitor who still holds a cire session is sent to the dashboard with `location.replace`, so the login page leaves no history entry to bounce back through; everyone else sees the two buttons with no wait, because the check runs after the panel renders and an unreachable API reads as signed out.

Two things about that check are worth keeping straight:

- **It can only see cire's own cookie.** A session at the issuer is invisible from a `cireweddings.com` origin: `osn-api` sets its session cookie `SameSite=Lax` (`osn/api/src/lib/cookie-session.ts`), and a Lax cookie rides only top-level navigations, never a background request from another site. So a hidden-iframe `prompt=none` probe would report "signed out" in every browser, whatever the third-party-cookie policy — and asking properly means a top-level redirect, which is the behaviour this replaced. It is also why `prompt=none` stays off the start leg's allowlist.
- **It backs off rather than looping.** `/` bounces a 401 to `/login`, and `/login` now bounces a session to `/`; a disagreement between the two — a session expiring between the calls — would ping-pong. `resumeSession` stamps `rp-auth.resumed-at` in `sessionStorage` and skips the next resume within 5 seconds, so a loop stops after one lap while a deliberate return visit minutes later still gets carried through. Signing out clears the stamp.

### Sign-in chain (click → cookie)

```
@shared/rp-auth startSignIn()          top-level navigation, never fetch
  │  (startCreateAccount() is the same call plus prompt=create)
  └─▶ GET /api/auth/oidc/start?return_to=…[&prompt=create]   cire-api (cire/api/src/routes/auth-oidc.ts)
        │  mints state + nonce + PKCE verifier (S256), stashes them with return_to
        │  in a 10-min HttpOnly tx cookie; return_to checked against the CORS allowlist
        └─▶ 302 → {OSN_ISSUER_URL}/authorize      passkey ceremony + consent on musubi.social
              └─▶ 302 → /api/auth/oidc/callback   the ONE registered redirect URI
                    ├─▶ state match               constant-time, against the tx cookie
                    ├─▶ POST /oidc/token          client_secret_post + code_verifier
                    ├─▶ verifyIdToken()           @shared/osn-auth-client/verify-id-token —
                    │                             ES256 via JWKS, iss/aud/exp/nonce all pinned
                    ├─▶ osn_profile_id claim      first-party only; absent ⇒ token_invalid
                    └─▶ organiserSessionService.create()
                          └─▶ Set-Cookie cire_org_session=<256-bit>   302 → return_to
```

Four routes make up the surface, plus the middleware:

| | |
|---|---|
| `GET /api/auth/oidc/start?return_to=[&prompt=create]` | Leaves for the issuer. Missing OIDC config ⇒ **503** `sign_in_unavailable` — an honest "this tier cannot sign anyone in", not a silent downgrade. `prompt` is **allowlisted to `create`** and any other value is dropped, not rejected: the query string is attacker-reachable, and forwarding it blind would let anyone turn a sign-in link into `prompt=none` and ask for a grant with no screen at all. |
| `GET /api/auth/oidc/callback` | Exchanges the code and sets the cookie. Every failure redirects back to `return_to` with `?auth_error=sign_in_declined` (the user said no) or `sign_in_failed` (everything else). The issuer's own error string is never echoed back to the browser. |
| `GET /api/auth/session` | Who is signed in. Answers **200 `{signedIn: false}`** when nobody is — deliberately not 401, so the probe never trips `authFetch`'s session-expired path on a page a signed-out visitor may legitimately open. |
| `POST /api/auth/signout[?all=1]` | Revokes this session, or every session for the profile. Always 200, idempotent. |

**Why `osn_profile_id`, not `sub`.** OIDC hands out a **pairwise** `sub` (`pw_*`) — a different string per client sector, so no two relying parties can correlate a user. Every cire row keys on the real OSN profile id (`weddings.owner_osn_profile_id`, `wedding_hosts`, all three ARC bridges), so a `pw_*` sub would have orphaned the entire existing dataset. Cire is registered **first-party**, and a first-party ID token carries an extra `osn_profile_id` claim holding the real `usr_*`. A token that arrives without it is refused (`token_invalid`) rather than falling back to `sub` — a fallback would silently mint sessions keyed on the wrong identity.

**The cookie.** `cire_org_session`, 256 bits from `crypto.getRandomValues`, stored **SHA-256-hashed** in `organiser_sessions` (migration `0047`), `HttpOnly; SameSite=Lax; Path=/`, 7-day TTL, host-scoped to the API origin (`api.cireweddings.com`) — so the portal's own origin can never read it and every call rides `credentials: "include"`. `Secure` tracks the configured web origin's scheme, the same test the guest cookie uses.

**Why `SameSite=Lax` and not `Strict`.** The callback is a cross-site top-level GET arriving from `musubi.social`; `Strict` would drop the cookie on exactly the navigation that sets it. Lax plus the app-wide `originGuard` is the pair that covers organiser writes — see [CSRF origin guard](#csrf-origin-guard-c5--s-l3). Both have to stay.

**Open-redirect guard.** Exactly one redirect URI is registered per environment (`…/api/auth/oidc/callback` on the API host), so the issuer's own allowlist is a single value. The real destination rides in the tx cookie, not in the URL, and is re-validated against the CORS allowlist both when it goes in and when it comes back out.

**Client auth is `client_secret_post`, never Basic.** The issuer's token endpoint rejects a request that carries both (RFC 6749 §2.3). `CIRE_OIDC_CLIENT_SECRET` is a wrangler secret; its SHA-256 lives in osn-api's `oauth_clients.client_secret_hash`. Rotating it means changing **both** — see [[production-deploy]].

`osnAuth()` is mounted on `/api/organiser/*`. It resolves the cookie against `organiser_sessions` first and falls back to Bearer-token verification (`@shared/osn-auth-client` `extractClaims` → ES256 + JWKS cache → `aud === "osn-access"`) for non-browser callers. Either way it only authenticates — it says "this is OSN profile `usr_…`", nothing about which wedding they may touch.

**Account management stays on musubi.** Passkeys, recovery codes, sessions and email changes are all step-up-gated ceremonies that must run on the RP-ID origin. The portal's `SecurityPanel` no longer renders them; it links out to `PUBLIC_OSN_ACCOUNT_URL` (`https://musubi.social`) instead.

### Authorisation: wedding ownership

`weddings.owner_osn_profile_id` stores the owning OSN profile id as an **opaque string** — no cross-DB FK (cire's D1 and OSN's DB are separate databases; the id is a foreign-system reference, not a relation). Three per-wedding gates enforce it, split by authorisation level (Phase 0 roles PR added the middle tier):

- **`weddingOwner()`** — **owner-only**, for the destructive / wedding-administration routes under `/api/organiser/weddings/:weddingId/*`: `regenerate-code`, `remint`, `mark-shared`, family `deactivate`/`reactivate` (claim codes are the guest credential, so cutting one off is code management), the **subtractive** half of co-host management (`DELETE /hosts/:osnProfileId`, `PUT /hosts/:osnProfileId/role` — only the owner demotes or evicts a co-host). **Adding** a co-host moved to `weddingEditor()` — see the matrix below. Loads the wedding row: unknown wedding → **404** `wedding_not_found` (don't disclose existence), owner mismatch → **403** `forbidden`. Sets `c.var.weddingId`.
- **`weddingEditor()`** — **owner OR `editor` co-host**, for the module WRITE surface (`cire/api/src/middleware/wedding-editor.ts`): the **spreadsheet import** routes (`/import/preview`, `/apply`, `/revert`, `/list` — the whole subtree is write-shaped, even preview persists an import row), the **invite-builder writes** (`PUT /invite/text`, `PUT /invite/theme`, image upload/delete/crop, event images), the per-event **location** write (`PUT /events/:eventId/location`) and its **geocode** helper (`POST /settings/geocode` — billed upstream call). It also fronts **`PUT /settings`**, which is not a whole-route decision: the middleware says who may reach the handler, and the handler then rejects a NON-OWNER patch touching anything but the RSVP-by deadline with **403 `owner_only_fields`** (naming the offending keys). Shape is decoded first, so a co-host's malformed date is still a 400; the refusal is whole, never a partial write, and never a silent filter. A `viewer` co-host gets **403 `read_only_role`** (a distinct error string so the portal can say "ask the owner for editor access"); non-members get the member gate's 404/403 semantics unchanged.
- **`weddingMember()`** — **owner OR any co-host (editor AND viewer)**, for the read surface: the dashboard reads (`/guests`, `/events`, `/rsvps`), the CSV exports, `GET /settings`, the co-host read route (`GET /hosts`), the invite read (`GET /invite`), and `preview-code` (previewing is the read experience — see above). Resolves authorisation in one round-trip via `hostsService.authorize()` (owner-id lookup + host-row probe incl. the seat's role), so it both admits the caller and exposes `weddingIsOwner` + `weddingRole` for any route that wants to keep a higher-privilege affordance inside a member-gated tree. Same 404/403 semantics; **fails closed** if the host/ARC lookup is unavailable. Sets `c.var.weddingId` + `c.var.weddingIsOwner` + `c.var.weddingRole`.

**Roles capability matrix** (platform-plan §3.5, shipped Phase 0 PR 2). `wedding_hosts.role` is `editor | viewer` (app-layer enum — no DB CHECK; migration `0031` rewrote the legacy `'host'` rows to `'editor'`, and readers normalise any stray `'host'` — still the column's DDL DEFAULT, unchangeable without a rebuild — to `editor`, while any OTHER unknown/corrupted value degrades to `viewer` so the gate chain never fails open — S-L1, see [[changelog/security-fixes]]):

| Action | Owner | Editor | Viewer | Gate |
|---|---|---|---|---|
| View guests / events / RSVPs dashboard, CSV exports, `GET /settings`, `GET /invite`, `GET /hosts` | ✅ | ✅ | ✅ | `weddingMember()` |
| Preview the invite (`POST /preview-code`) | ✅ | ✅ | ✅ | `weddingMember()` |
| Spreadsheet import — preview / apply / revert / list | ✅ | ✅ | ❌ | `weddingEditor()` |
| Customise the invite (text / theme / images / crops) | ✅ | ✅ | ❌ | `weddingEditor()` |
| Event locations (`PUT .../location`) + geocode | ✅ | ✅ | ❌ | `weddingEditor()` |
| Regenerate / re-mint claim codes, mark-shared, deactivate/reactivate a household | ✅ | ❌ | ❌ | `weddingOwner()` |
| Wedding settings — name / date / guest count / currency (`PUT /settings`) | ✅ | ❌ | ❌ | `weddingEditor()` + field check |
| The RSVP-by deadline (`PUT /settings`, `rsvpDeadline` + `rsvpDeadlineTimezone`) | ✅ | ✅ | ❌ | `weddingEditor()` |
| **Add** a co-host (`POST /hosts`) | ✅ | ✅ | ❌ | `weddingEditor()` |
| **Remove** a co-host, change a co-host's role | ✅ | ❌ | ❌ | `weddingOwner()` |
| Delete the wedding | ✅ | ❌ | ❌ | `weddingOwner()` |

The rationale: the spreadsheet is the primary way a wedding's guests + events are populated, and the invite is the thing the couple shapes together — locking either to the single owner defeated the point of co-hosting, and a hired *wedding planner* is exactly an `editor`. A `viewer` (a parent, a curious sibling) can watch RSVPs land without being able to change anything. The owner-only line is drawn at *managing the wedding itself*: rotating/cutting off guest credentials, wedding identity + money settings, changing who the co-organisers are, and deleting the wedding. **Adding a co-host** is the second place that line bends, and it bends on the additive-versus-subtractive axis rather than the read-versus-write one. An editor may grow the team; only the owner may shrink or demote it. Two properties make that safe. First, `editor` is the ceiling of what anyone can grant — `role` is `editor | viewer` and the owner is never rowed into `wedding_hosts` — so an editor adding an editor is adding a **peer**, never a superior, and there is no path to owner. Second, because removal and demotion stay owner-only, an editor cannot evict the owner's other co-hosts, cannot demote a rival to `viewer`, and cannot entrench themselves; every seat an editor creates is reversible by the one person who cannot be removed. The worst case is an unwanted addition the owner then deletes. It exists because the alternative was worse in practice: the owner was the single person who could bring anyone on board, so handing out claim codes bottlenecked on them even when three people were running the wedding. The same reasoning — and the same additive-only shape — as the account-linking route. The **RSVP-by deadline** is the one field inside owner-only Settings that an `editor` may write — it runs the wedding rather than describing it (the co-host chasing replies is exactly who needs to move the date, and nothing about it is irreversible), which is why the settings row above splits in two. See [[cire/wiki/systems/rsvp-deadline]].

Co-hosts live in the `wedding_hosts(wedding_id, osn_profile_id, role, …)` table (unique per pair) — it stores **only the profile id**, never the handle. They're added **by OSN handle** — `POST /hosts` (body `{handle, role?}`, role defaults to `editor` so pre-roles portal builds keep working; **owner or `editor`**) resolves the handle to a profile id via an ARC-gated osn-api `GET /graph/internal/profile-by-handle` call (`graph:read` scope) before inserting the row (#148); `PUT /hosts/:osnProfileId/role` flips a seat between `editor` and `viewer` (404 `host_not_found` for non-seats, incl. the owner — the owner is never rowed in). The portal's wedding list (`GET /weddings`) tags each row with the caller's role (`owner | editor | viewer`) so the UI can hide write/management surfaces; the API gates remain the enforcement.

`GET /hosts` resolves the stored profile ids back to **handles live** for display: it batches the row's `osn_profile_id`s into one ARC-gated `POST /graph/internal/profile-displays` (`graph:read`) call and merges `{handle, displayName}` into the response. The handle is the on-screen value; the **profile id is a last-resort fallback only** (the handle is never denormalised into `wedding_hosts`). The display resolver is **key-optional + fail-soft**: when the ARC key is absent/malformed or osn-api is unreachable, it returns an empty map and the list degrades to showing profile ids — never a 503/500 (host listing must not break on a display-lookup failure).

**Co-host autocomplete.** `GET /api/organiser/handle-search?q=<query>` suggests who the organiser might mean as they type into the add-host input. It is gated by **`osnAuth()` alone — NOT wedding-scoped** (no `:weddingId`, no `weddingOwner()`): the suggestion list isn't tied to a wedding, and any signed-in organiser may ask "who might this be?" while deciding who to add. A light per-IP rate limit (60/min) caps the per-keystroke ARC-sign + S2S amplifier.

It merges **two ARC-gated (`graph:read`) sources, in this order**:

1. **The caller's own OSN connections** — `GET /graph/internal/connection-search?profileId=&q=&limit=` via the `OsnConnectionSearchResolver` bridge, flagged `connected: true` in the response. These rank **first** because a wedding's co-hosts are nearly always people the organiser already knows on OSN (a partner, a sibling, the planner they connected with), and because picking a connection is the case where the organiser can be confident they have the right `@handle` rather than a stranger with a confusable one. `profileId` is the **caller's own token `sub`**, never a client-supplied value — an organiser can only ever search their own graph.
2. **The global handle prefix search** — `GET /graph/internal/profile-search?prefix=&limit=` via `OsnHandleSearchResolver`, flagged `connected: false`, filling the remainder. Kept deliberately: a co-host is *not required* to be a connection, and dropping this source would turn "not connected yet" into "cannot be added" — a regression for exactly the planner-hired-last-week case.

A profile in both sets is emitted once, from the connections source (so `connected` is never understated); the caller themselves is filtered out of both (the owner already hosts the wedding — `POST /hosts` answers 409 `owner_is_host`); the merged list is capped at 8.

An **empty query is valid and is not the same as a missing one**: it returns the organiser's first page of connections and nothing from the global search, which is what lets the portal open its dropdown on focus, before a keystroke. Both sources are **key-optional + fail-soft**, and are caught **independently** so one failing lookup degrades only itself — a missing/malformed ARC key or an unreachable osn-api returns `{ profiles: [] }` (or just the surviving half), never a 503/500, and the manual type-and-submit add path on `POST /hosts` is unaffected throughout.

**Enumeration guardrails live in osn-api**, and differ per source because the two have different exposure:

- `profile-search` walks the whole handle namespace: minimum prefix length 2 (a 1-char/empty query returns an empty list, not an error), results ordered by handle, **hard-capped at 10** (default 8), backed by the `users_handle_idx` B-tree index on `users.handle`.
- `connection-search` returns only one profile's **own accepted connections** — a list that profile can already read in full via the user-facing `GET /graph/connections`. There is therefore **no minimum length** (no namespace to enumerate, and the empty query is the on-focus case) and matching widens to a **display-name substring** as well as a handle prefix (you remember a connection as "Priya", not as `@pk_1994`). `status = 'accepted'` only — a pending request is not a connection, and surfacing one would leak that a request is in flight. Blocks need no separate filter: blocking deletes the connection row.

Both exclude tombstoned accounts (`deletedAt IS NULL`), so an account mid-deletion never surfaces as a suggestion.

**Privacy posture**: handles are public identifiers (like @usernames); the connection source discloses essentially nothing new to a `graph:read` holder either, since `/graph/internal/connections` already returns any profile's connection ids under that scope and `/profile-displays` already maps ids → handle + displayName — `connection-search` is those two calls fused, filtered, and capped. One caveat keeps that equivalence from being exact: `/connections` clamps at 100 rows and exposes no `offset`, so for a profile with **more than 100 connections** a filtered `connection-search` can reach an edge that paging `/connections` cannot. Marginal (extraction still costs one query per targeted fragment, and the audience is two first-party services), but recorded because the equivalence argument is the load-bearing reason this shipped without a new ARC scope. Adding an `offset` to `/connections` would make it exactly true.

**Caller invariant**: the `profileId` `connection-search` takes is the **calling service's own authenticated end user** — for cire, the `osnAuth()`-derived `osnProfileId`, i.e. the access token's `sub` — and never a value from a client request. The ARC gate authenticates the *service*, not the end user it acts for, so osn-api cannot enforce this; a consumer that forwarded a client-supplied id would turn the endpoint into arbitrary graph enumeration. `/graph/internal/connections` has the identical shape, so this is an inherited invariant rather than a new one.

`POST /api/organiser/weddings` (create) and `GET /api/organiser/weddings` (list) carry no `:weddingId` and are gated by `osnAuth()` alone — the owner is the verified caller, taken from the token, never the body.

> **Any authenticated OSN user is a first-class organiser.** There is no seeded
> owner and no global boot gate: a freshly signed-in account that owns/co-hosts
> nothing gets `GET /api/organiser/weddings` → `200 {weddings: []}` (never a
> 404/503) and creates its first wedding via `POST /api/organiser/weddings`
> (`201`, owned by the caller). Portal entry is gated by `osnAuth()` alone;
> everything wedding-scoped is then scoped per-wedding by `weddingOwner()` /
> `weddingMember()`, so one user can never see or mutate another's wedding. The
> old `BOOTSTRAP_OWNER_PROFILE_ID` env var + `ensureBootstrapOwner` boot fixup
> (which threw → 503 in any deployed env until a real `usr_*` owner was set, back
> when cire centred on a single seeded demo wedding `wed_bootstrap`) are
> **removed** — that demo wedding is deleted by migration
> `0015_drop_bootstrap_wedding.sql`. (`feat/cire-organiser-open-access`.)

> The earlier `ownedWedding()` middleware (which derived a single owned wedding and 400'd when a caller owned more than one) was **removed** when organisers gained the ability to own multiple weddings — the import routes now take an explicit `:weddingId` under `weddingOwner()`.

### Error-code design: 403 vs 401 (real bug class)

`authFetch` in `@shared/rp-auth` treats **401 as "the session is gone"**: it throws `AuthExpiredError`, and the portal drops its cached session and bounces to sign-in. So an *authenticated-but-forbidden* caller (valid session, not the wedding owner) **must get 403, never 401** — a 401 here would log the organiser out over an authorisation problem. We hit this during the merge; the middlewares are written around it:

- 401 → only from `osnAuth()` (no cookie, unknown/expired session, bad token) — that is, "sign in again".
- 403 → authenticated, not authorised (`weddingOwner()` owner mismatch, or `weddingMember()` neither-owner-nor-co-host) — "you can't touch this".
- 404 → resource existence not disclosed (unknown wedding, no owned weddings).
- 400 → ambiguous request shape (`multiple_weddings`).

The same rule is why `GET /api/auth/session` answers **200 `{signedIn: false}`** rather than 401 — the probe would otherwise report "expired" to every signed-out visitor.

`@shared/rp-auth` exports `isAuthExpired(err)` — Effect's FiberFailure wrapping defeats `instanceof`, so it checks the `_tag` discriminant instead.

**Corrected 2026-07-30.** This paragraph used to claim nothing string-matches `"AuthExpiredError"` any more, and that the `@osn/client` debt was closed. Neither was true. `cire/organiser/src/lib/api.ts` keeps its own `isAuthExpired` with a printout-matching third arm on top of the `_tag` check, and `@osn/client` had no predicate at all until one shipped on 2026-07-30 (`isAuthExpiredError`, next to the error class). The two are **not** interchangeable and the organiser was deliberately left on its own: since the OIDC swap its errors come from `@shared/rp-auth`'s `AuthExpiredError`, a plain `Error` subclass, not `@osn/client`'s `Data.TaggedError` — same name, different class.

Both predicates guard the `String(err)` call. It throws on a null-prototype object, and they run inside `catch` blocks, so an unguarded throw there swaps a recoverable expiry for an unhandled rejection. Pinned by `cire/organiser/src/lib/api.test.ts` and `osn/client/tests/errors.test.ts`; the latter builds a **real** FiberFailure rather than a hand-written string, so an Effect upgrade that changes the printout fails a test instead of a redirect.

## No overlap

The two middlewares never run on the same route **except the account-link POST below**, and even there they are not a privilege ladder. `sessionAuth()` gates guest routes (`/api/rsvp`); `osnAuth()` (+ the role gates) gates `/api/organiser/*`. Outside the linking POST there is no route that accepts either credential, no privilege ladder from guest session to organiser, and no shared token format.

Both cookies now sit on the same host (`api.cireweddings.com`), so a browser holding both sends both on every call — but they are read by name and stored in **different tables**: `cire_session` → `sessions` (family-scoped), `cire_org_session` → `organiser_sessions` (profile-scoped). `sessionAuth()` never looks at the organiser cookie and `osnAuth()` never looks at the guest one, so co-residency grants nothing: a leaked guest cookie can never reach organiser surface and an organiser cookie is meaningless on the RSVP endpoint. The interim `X-Organiser-Token` shared secret that predated this model is fully deleted.

## Guest account linking (the one deliberate dual-credential route)

An invitee may **optionally** attach their seat to a real OSN/Pulse account so they can see the invitation inside Pulse, and — within a family group — see other invitees' latest RSVPs. This is the **only** surface that requires both credentials at once, and it is **additive, not a ladder**: the OSN token grants no cire authority; it only names *which OSN account* to staple onto a household the guest session has already proven.

| | |
|---|---|
| Endpoints | `POST /api/account/link` (dual-credential), `GET /api/account/link`, `DELETE /api/account/link/:guestId` (guest-only) |
| Middleware | `sessionAuth()` (Elysia plugin) on all methods; `osnAuth()` **method-gated to POST** by mounting it on a sibling Elysia instance — `createAccountLinkPostRoute` (POST, sessionAuth + osnAuth) and `createAccountLinkRoutes` (GET/DELETE, sessionAuth only) share the prefix but not the OSN gate, the same sibling-instance pattern that keeps `/api/rsvp` ungated by the organiser `osnAuth` |
| Table | `guest_account_links` (`@cire/db`) — **per invitee** (`guests` row), not per family |
| Stored id | `osn_account_id` (account-level, so any of the user's OSN profiles can see the invitation) + `osn_profile_id` (audit). Opaque cross-DB references, no FK — same rule as `weddings.owner_osn_profile_id`. |

**The bind.** `POST /api/account/link` carries `{ guestId }`. `sessionAuth()` proves the household (`familyId`); the `guestId` must belong to that family (else **403**). `osnAuth()` proves the OSN identity (`osnProfileId`, resolved from the `cire_org_session` cookie the guest picked up by signing in through the OIDC redirect). Both cookies are host-scoped to the API origin, so one `credentials: "include"` fetch carries both. The profile is resolved to its **account id** server-to-server over [[arc-tokens|ARC]] (`GET /graph/internal/profile-account`, dedicated `graph:resolve-account` scope — the endpoint rejects plain `graph:read` since S-M1 pulse-onboarding, 2026-07-05; cire-api's prod key registration must carry `graph:read,graph:resolve-account`, see [[production-deploy]] §6) — account id is S2S-only and never returned to the client. The link row staples `guestId → osn_account_id`.

**Uniqueness.** One link per invitee (`guest_id` unique); one OSN account can't claim two seats in the same household (`(family_id, osn_account_id)` unique); the *same* account linking across different weddings is allowed (one person, many invitations). Conflicts → generic **409 `already_linked`** (no enumeration).

**401 here is correct (no 403 hazard).** Unlike the organiser 403-vs-401 rule above, a **401 from `osnAuth()` on the link POST is the right answer**: the guest's cire session for their OSN identity has expired, and the right response is to send them back through the sign-in redirect. There is no authorisation wall to mask — the guest is *re-authenticating to OSN*, not being denied a cire resource. `GET`/`DELETE` never invoke `osnAuth()` (a guest whose OSN sign-in lapsed can still read/remove their household's links), so they can't trip it.

**ARC on Workers.** cire/api runs on workerd, so it mints the outbound ARC token via the DB-free, metric-free `@shared/crypto/jwk` `signArcToken` (the barrel `@shared/crypto` and `@shared/observability` don't bundle for workerd). Key distribution is a **stable** ES256 key (`CIRE_API_ARC_PRIVATE_KEY` wrangler secret) pre-registered in osn-api's `service_accounts` under serviceId `cire-api` — not the ephemeral-key self-registration + rotation that long-lived bun services use, because a Worker has no startup hook. When the ARC key is absent the POST answers **503** (linking is opt-in; the rest of cire is unaffected). The resolver is injectable (`createApp({ resolveOsnAccountId })`) so tests stub it.

**Session rotation on link (C6).** A successful `POST /api/account/link` **rotates the guest session**: it mints a fresh token and revokes the presented one in a single atomic batch, then returns a new `Set-Cookie`. Linking is a privilege change (the household becomes bound to an OSN account), so any token an attacker may have planted before the legitimate user linked is invalidated in the same commit — a session-fixation defence (`sessionService.rotate`). Rotation is best-effort: if the write fails the link still stands and the existing session is kept (logged), rather than 500-ing a completed link. Clients must use the rotated cookie for subsequent requests; the old one no longer validates.

**The browser-side affordance shipped with the OIDC swap** — `cire/web/src/components/PulseAccountLink.tsx`, rendered under the claimed invite. It is strictly additive: every failure path degrades to a hidden or quiet control, never a broken invite.

1. Probe `GET /api/account/link` with the guest cookie alone. **503 ⇒ the whole panel renders nothing** (that deployment has no ARC key, so linking is off). Any other non-OK ⇒ also hidden.
2. Signed out, it offers "Sign in with musubi" — `signIn(window.location.href)`, the same top-level redirect the organiser portal uses. The guest cookie survives the round trip, so the guest comes back to the claimed invite with the panel signed in.
3. Signed in, the guest picks **which household member they are** and the panel POSTs `{ guestId }` through `authFetch`. **409 is treated as success**, not an error: the seat is linked either way, and surfacing "already linked" as a failure would be a lie. 403 → "That isn't one of your household's guests." A thrown `AuthExpiredError` flips the panel back to the sign-in button.
4. Unlink is optimistic and idempotent — the indicator flips at once, and a `404` from `DELETE /api/account/link/:guestId` counts as done.

## CSRF origin guard (C5 / S-L3)

**Both** cookies carry auth state — `cire_session` since the beginning, `cire_org_session` since the OIDC swap — so cire needs CSRF defence beyond `SameSite=Lax`, and the organiser surface now needs it as much as the guest one (before the swap it was Bearer-only and therefore CSRF-immune by construction). A root-level Elysia `onBeforeHandle` (`cire/api/src/lib/origin-guard.ts`, mounted in `createApp` before the route factories) validates the `Origin` header on **every state-changing method** (POST/PUT/PATCH/DELETE) against the same allowlist CORS echoes (derived from `WEB_ORIGIN`). Missing or mismatched Origin → **403** with a bounded `cire.origin_guard.rejections{reason}` metric (`missing | mismatch`). cire has **no** inbound ARC/S2S routes (unlike osn-api, whose guard exempts them), so there is no exemption — every state-changing request is checked. An empty allowlist (local dev) disables the guard.

**The two OIDC legs are GETs, so the guard does not see them** — by design, since a cross-site top-level navigation is exactly what they are. `/oidc/start` mints no state and grants nothing, so it is not worth protecting. `/oidc/callback` is protected instead by the **`state` match** against the HttpOnly tx cookie: an attacker cannot forge a callback that lands a session on the victim's browser without also knowing the `state` the victim's own `/oidc/start` minted. That is the standard OIDC login-CSRF defence and it is the reason `state` is mandatory here, not optional.

## Related

- [[identity-model]] — OSN accounts, profiles, access-token contract
- [[oidc-provider]] — the issuer side: authorize/token endpoints, PKCE, consent, pairwise `sub`, first-party claims
- [[musubi-identity-migration]] — the RP-ID move that forced this flow
- [[passkey-primary]] — the passkey-only login organisers use, now spent on `musubi.social`
- [[sessions]] — OSN's own server-side session store (separate from cire's two)
- [[cire]] — app overview, packages, data model
- [[data-map]] — cire personal-data fields (the `public_id` claim code is a credential; `cire_session` redacted in logs)
- [[access-control]] — cire D1/R2 operator access + these credential classes in the access matrix
