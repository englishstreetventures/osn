# @osn/osn

## 3.9.6

### Patch Changes

- 6a38d0f: Add `org:read` to the register-service permitted-scopes allowlist in `@osn/api` so downstream services (cire-api) can resolve OSN org membership over ARC for the Vendors feature. Add the `vendor-claim-invite` transactional email template to `@shared/email` (fail-soft: sent on claim-token minting; missing `RESEND_API_KEY` degrades to a logged no-op).
- Updated dependencies [6a38d0f]
  - @shared/email@0.3.4

## 3.9.5

### Patch Changes

- 9856ea5: Prune the transitional `app.cireweddings.com` origin from osn-api's production
  `OSN_ORIGIN` / `OSN_CORS_ORIGIN` allowlists now that the organiser portal has
  cut over to `host.cireweddings.com`. RP ID stays the registrable apex, so
  existing organiser passkeys are unaffected. Also drops a stale "deploy osn-api
  manually" comment (osn-api is CI-deployed since 2026-07-16).

## 3.9.4

### Patch Changes

- d32fd6f: CI: auto-deploy osn-api to production. Add a `deploy-osn-api` job to
  `.github/workflows/deploy.yml` (mirrors `deploy-cire-api`): on merge to `main` it
  applies the prod osn D1 migrations (`wrangler d1 migrations apply osn-db-prod
--remote --env production`) then deploys the Worker (`wrangler deploy --env
production`) against the already-set out-of-band secrets.

  Removes the last manual production deploy step. osn-api has been a deployed
  Cloudflare Worker (workerd + Upstash + native rate-limiters) since the 2026-06
  cutover, so the old "gated until the ioredis→Workers-Redis swap" reason in the
  `deploy.yml` stub was stale. Merging this PR runs the job, which also picks up the
  domain-reshuffle `OSN_ORIGIN`/`OSN_CORS_ORIGIN` (`host.cireweddings.com`) already
  on `main`. As with cire-api, osn's D1 migrations now auto-apply on merge.

## 3.9.3

### Patch Changes

- c256caf: Domain reshuffle (organiser portal `app.cireweddings.com` → `host.cireweddings.com`):
  add the new portal origin to osn-api's prod WebAuthn/CORS allowlists.
  `[env.production].OSN_ORIGIN` and `OSN_CORS_ORIGIN` now list
  `https://host.cireweddings.com,https://app.cireweddings.com` (both kept for the
  switchover window; prune `app.` after the move + verify).

  `OSN_RP_ID` stays `cireweddings.com` (the registrable apex), so existing organiser
  passkeys keep working on the new subdomain with no re-registration — credentials
  are scoped to the RP ID, not the full origin. osn-api is deployed MANUALLY (not
  CI): run `cd osn/api && bunx wrangler deploy --env production` after this merges
  for the var change to take effect.

## 3.9.2

### Patch Changes

- 7a36be4: Test-hardening (test-only, no production behaviour change): add direct,
  deterministic coverage for the refresh-rotation compare-and-swap (CAS)
  family-revoke branch in `refreshTokens` (landed in #253).

  Previously the happy path and the `verifyRefreshToken` → `detectReuse` reuse
  path were tested, but the CAS-0-rows branch — where the session row is present
  at verify time yet the rotation DELETE reports 0 rows affected (a concurrent /
  replayed writer already rotated it out) — had no direct test. The new test
  proxies the drizzle `Db` handle to force the DELETE to report 0 rows on demand
  (the row is genuinely removed, mirroring a lost CAS) and asserts the reuse
  guarantee: the whole session family is revoked, no sibling session is minted,
  and the reuse / family-revoke metrics fire. A control case proves the
  interception — not a broken layer — is what drives the branch.

## 3.9.1

### Patch Changes

- f569c7c: Harden ARC S2S auth: bind the public-key cache to `(issuer, kid)` and fix Origin-guard S2S drift.

  The ARC public-key cache was keyed by `kid` alone, so a cache hit returned the
  key for whatever `issuer` the caller passed — silently skipping the
  `serviceId == issuer` DB binding that only runs on the miss path. The same
  forged-`iss` token was therefore rejected on a cold cache but accepted on a warm
  one. The cache is now keyed by `(issuer, kid)` so the binding holds on both
  paths; `evictPublicKeyCacheEntry` scans the composite keys. `verifyArcToken` now
  requires `exp`/`iat`/`iss`/`aud` via jose `requiredClaims` so a token minted
  without `exp` can never be treated as non-expiring.

  The Origin-guard's hardcoded S2S exemption list had drifted from the real
  internal route prefixes (`/internal/*` was unlisted and `/organisation-internal`
  matched no route), so in production every ARC POST to `/internal/*` was 403'd
  before ARC verification ran. The guard now exempts on the `Authorization: ARC`
  header (immune to route renames) with segment-boundary path matching as a
  secondary signal.

- f569c7c: Harden deployment posture and the Pulse Worker's JWKS scheme check.

  - Pulse's Workers entry now fails closed when `OSN_JWKS_URL` is missing or
    plaintext `http://` in a non-local env (mirrors zap-api), so a misconfigured
    JWKS URL can't let a network attacker serve a forged key set.
  - `workers_dev = false` on the top-level (env-less) wrangler configs for osn-api
    and cire-api, and the `deploy` scripts are now `wrangler deploy --env
production`. A bare `wrangler deploy` (which binds the production D1 with a
    local security posture) now fails loudly instead of publishing a public shadow
    Worker. Real deploys go through `--env production`; CI migrations are
    unaffected.

- f569c7c: Close org privilege-escalation via add/remove and gate the member roster.

  The owner-only role gate (`updateMemberRole`) was bypassable: `addMember` let
  any admin insert a target as `admin`, and `removeMember` let any admin remove
  other admins — so an admin could mint or strip admins via remove+add. Granting
  `admin` now requires the owner, and removing an admin now requires the owner;
  admins may still add and remove plain members.

  `GET /:handle/members` returned the full roster (handles, display names, roles)
  to any authenticated user with no membership check. It is now restricted to
  members of the org. If public org pages are desired later, gate on an explicit
  `organisations.visibility` flag rather than dropping the check.

- f569c7c: Make refresh-token rotation atomic (compare-and-swap on the old session).

  `refreshTokens` verified the session then deleted-old/inserted-new in a batch.
  Two concurrent refreshes presenting the same token both passed verification and
  both inserted a new session, leaving two live sessions in one family with reuse
  detection never firing. The old-session DELETE is now the CAS gate: rotation
  proceeds only while the old row still exists (rows-affected == 1); a 0-rows
  result means the token was already rotated out (concurrent refresh or replay),
  which is treated as C2 reuse — the whole family is revoked instead of minting a
  sibling session. Mirrors the recovery-code CAS already in this file.

- Updated dependencies [f569c7c]
  - @shared/crypto@0.8.6

## 3.9.0

### Minor Changes

- 6b14961: C-H1 — account data export (`GET /account/export`, DSAR Art. 15 / 20 + CCPA).

  Self-service, step-up gated (new `account_export` step-up purpose), rate-limited
  to 1 export / 24 h / account. Streams the locked NDJSON bundle
  (`{"version":1,...}` header → `{"section","record"}` lines → `{"end":true}`
  terminator) via a `ReadableStream`, so the response never materialises the full
  dataset. osn's own sections (account, profiles, passkeys, sessions,
  security_events, recovery_codes counts, email_changes, connections, blocks,
  organisations) are read with keyset pagination (`LIMIT 500 WHERE id > :cursor`,
  no OFFSET). The internal `accountId` is never emitted (P6 invariant).

  The `pulse.*` / `zap.*` sections are fetched over ARC (new `account:export`
  scope, registered downstream alongside `account:erase`) from a new
  `POST /internal/account-export` on each app and streamed through the outer
  envelope line-by-line; a failing bridge degrades to a `{"degraded":...}` line
  rather than breaking the stream. Pulse returns rsvps / events-hosted /
  close-friends; Zap returns chat memberships only (message ciphertext excluded).

  Also builds Zap's inbound-ARC infrastructure from scratch (it previously had
  none): `zap/api` gains an `arc-middleware` (`requireArc` + key registry +
  `register-service` bootstrap) mirroring Pulse's, closing the latent gap where
  osn's cross-service fan-out targeted a Zap `/internal` surface that did not
  exist.

  `@shared/observability` adds the `account_export` value to the `StepUpPurpose`
  metric-attribute union.

- 6b14961: C-H8: COPPA under-13 age gate on registration.

  `POST /register/begin` now requires a `birthdate` (`YYYY-MM-DD`). The
  registration service validates the date format (`BirthdateSchema`) and then
  hard-rejects any registrant under 13 with a new `AgeRestrictionError` →
  HTTP 422 `{ error: "age_restricted", message: "OSN is for users 13 and older" }`
  — **before** any collision probe or OTP dispatch, so OSN never gains "actual
  knowledge" of a child's data. The birthdate is a transient argument and is
  never written to any store or table (no rejected or accepted DOB retained).

  The client SDK's `beginRegistration` gains a required `birthdate` field, and
  `@osn/ui`'s `Register` form adds a date-of-birth input that mirrors the gate
  client-side for immediate feedback (the server remains authoritative). The
  legacy, unrouted `registerProfile` seed helper is intentionally left ungated.

  Also hardens `publicError`: `Effect.runPromise` rejects with a `FiberFailure`
  that stores the tagged error under a symbol-keyed `Cause`, which the previous
  walker never traversed — so every Effect failure silently fell through to the
  default 400. The walker now descends through all own keys (including symbols)
  and skips Effect's internal Cause tags, so tagged errors like
  `AgeRestrictionError` (422) map to their real status.

### Patch Changes

- Updated dependencies [6b14961]
  - @shared/observability@0.12.0
  - @shared/crypto@0.8.5
  - @shared/email@0.3.3
  - @shared/turnstile@0.2.3

## 3.8.10

### Patch Changes

- 630e98f: TODO-backlog hardening sweep:

  - **S-H (arc-scope-pattern)** — `@shared/crypto` `SCOPE_PATTERN` rejected hyphens, so every ARC token minted with the deployed hyphenated scopes (`step-up:verify`, `app-enrollment:write`) threw `Invalid scope format` at sign time — the Flow B leave-Pulse fan-out was broken end-to-end. Pattern now admits `-`; regression-tested round-trip.
  - **S-H1 (arc-key-scopes, prep-pr review) — mitigation** — osn-api stores `allowedScopes` per SERVICE (upsert = full replace) while pulse-api registers TWO keys under one serviceId; disjoint scope sets clobbered each other on every boot race / 24h rotation, randomly fail-closing either the graph bridge or Flow B. Both pulse registrations (graphBridge + outbound-arc) and the seed now carry the identical four-scope union, and the false "per-key isolation" comment is corrected. Real per-key scope storage is tracked in wiki/TODO.md.
  - **S-L1 (prep-pr review)** — osn-api's `requireArc` early exits (malformed token, unknown/revoked kid, registry scope denial) now record the shared `arc.token.verification` counter, mirroring the pulse receiver; infra (DB-query) failures are excluded from the counter.
  - **S-M1 (pulse-onboarding)** — dedicated `graph:resolve-account` ARC scope gates `GET /graph/internal/profile-account` (least privilege on the profileId → accountId lookup). Granted to pulse-api (self-registration + seed) and cire-api (runbook); a `graph:read`-only token now gets 401 on that endpoint.
  - **S-L6 (account-deletion)** — Pulse `requireArc` now records the shared `arc.token.verification` counter on its early-exit branches (malformed / kid-unknown / kid-revoked / registry-scope-denied); new bounded `revoked_key` result value in `@shared/observability`.
  - **S-M4 (auth)** — `loadJwtKeyPair` asserts the imported `OSN_JWT_PRIVATE_KEY` carries the `sign` usage, failing at boot when the public JWK is pasted into the private slot.
  - **S-L5 (auth)** — boot-time assertion that `OSN_ORIGIN` is set in non-local envs (mirrors the CORS fail-closed guard) instead of silently falling back to the localhost WebAuthn origin.
  - **M3 (Copenhagen)** — `EmailSchema` caps emails at 255 chars.
  - **Dead metric cleanup (pulse)** — `pulse.auth.jwks_cache.lookups` deleted (cache moved to `@shared/osn-auth-client`, uninstrumented); `pulse.events.create.duration` wired around `createEvent` via `withEventCreateDuration`; `pulse.events.host_cancelled.hard_delete` wired into `runEventCancellationSweep`.

- Updated dependencies [630e98f]
  - @osn/db@0.17.3
  - @shared/crypto@0.8.4
  - @shared/observability@0.11.2
  - @shared/email@0.3.2
  - @shared/turnstile@0.2.2

## 3.8.9

### Patch Changes

- f62784d: Code-quality sweep: lint-config repair + convention fixes monorepo-wide.

  - oxlint config: pin rules that leaked in via an upstream category re-shuffle
    (`no-underscore-dangle` off — Effect `_tag` is idiomatic;
    `unicorn/consistent-function-scoping` off — boot-time factory modules and
    Effect-context DI make it noise; `no-await-in-loop` off in tests), raise
    `jsx-a11y/control-has-associated-label` depth for Solid control-flow
    wrappers. 463 → 21 warnings; the survivors are the deliberate aspirational
    jsx-a11y set.
  - S-M5 (osn): `/account` erasure endpoints now thread `clientIpConfig` +
    socket peer into per-IP rate-limit keying (spoofable XFF no longer picks
    the bucket; unresolved IPs are denied, S-M34 posture) — with route tests.
  - pulse/api + zap/api route factories now build their Effect layer graph once
    per factory via `ManagedRuntime` instead of `Effect.provide(dbLayer)` inside
    every request (convention: `osn/api/src/lib/route-runtime.ts`); dead
    pre-instantiated route-group exports removed.
  - Dead exports removed: `decodeSession` (@osn/client), `getHandleFromToken`
    (@pulse/app).
  - Assorted lint fixes: variable shadowing renames, unused imports, promise
    handling in `TurnstileWidget`, `toSorted` in tests.

## 3.8.8

### Patch Changes

- 368e3e8: Performance audit sweep (versioned packages). No behavioural or security
  changes — fail-closed rate limiting, visibility gates, consent checks,
  single-use guarantees, and tenant scoping are preserved exactly.

  - `@zap/api`: `listChats` is cursor-paginated (default 50, max 100) with a
    composite `(createdAt, id)` keyset cursor (same-second creation bursts are
    never skipped) and caller-scoped cursors (unknown/foreign cursors
    rejected); `getChatMembers` is limit/offset-paginated (default 100, max 500) and skips its redundant existence load when the route has already
    asserted membership; both list responses carry `hasMore` (+ `nextCursor`
    for chats) continuation metadata; `addMember` checks the member cap with
    `COUNT(*)` instead of fetching every member row.
  - `@osn/api`: ceremony-store TTL sweep debounced to once per 30s (hard cap
    still enforced on every set); `beginRegistration`/`registerProfile`
    uniqueness probes collapsed to one round-trip via `UNION ALL` of two
    indexed single-table arms (an `OR` across the users-accounts join defeats
    SQLite's OR-optimization and plans as a full table scan);
    `sendConnectionRequest` reads run concurrently; `consumeRecoveryCode` is a
    single atomic conditional `UPDATE … RETURNING` (also closes the remaining
    check-then-act window); `countActiveRecoveryCodes` is a SQL aggregate that
    no longer fetches `code_hash` values; redundant accounts read moved out of
    the identified passkey-login path; per-call `TextEncoder` allocation and
    per-issuance `process.env` reads hoisted to module scope.
  - `@pulse/api`: status-transition persistence batched to one `UPDATE … WHERE
id IN (…)` per (from → to) group across all five list surfaces (was up to
    500 writes per GET on series instances); `updateSeries`/`cancelSeries`
    collapsed to single race-free `UPDATE … RETURNING`; `listTodayEvents`
    capped at 200 rows; RSVP routes thread the already-loaded event row into
    `listRsvps`/`rsvpCounts`/`latestRsvps`; `createEvent` uses `INSERT …
RETURNING`; `GET /events/:id/ics` sends `Cache-Control: private,
no-cache` + a weak ETag and honours `If-None-Match` (including `*` and
    multi-value lists) with 304 — every reuse revalidates through the
    visibility gate.
  - `@pulse/db`: new `event_rsvps_event_status_idx (event_id, status)`
    composite index; the subsumed single-column `event_rsvps_event_idx` is
    dropped (migration 0008).
  - `@osn/client`: `RegistrationClient.checkHandle` accepts an optional
    `AbortSignal` so debounced callers can cancel stale availability probes.
  - `@osn/ui`: `Register` and `CreateProfileForm` abort the previous in-flight
    handle check before issuing a new one and on unmount.
  - `@pulse/app`: Explore map resize handling is debounced (100 ms), grid
    geometry is memoized per size, and theme detection is a reactive
    `MutationObserver`-driven signal instead of a per-access DOM read.

## 3.8.7

### Patch Changes

- 5aa3273: Refactor the auth monoliths into module directories, behaviour-preserving. `services/auth.ts` (~4,500 lines) becomes `services/auth/` — domain factories (profiles, registration, tokens, passkeys, passkey management, profile switch, sessions, recovery, security events, step-up, email change, cross-device) composed over a shared `AuthContext` by `index.ts`; the three duplicated security-notification mailers collapse into one shared helper. `routes/auth.ts` (~1,800 lines) becomes `routes/auth/` — one Elysia route group per domain over a shared `AuthRouteContext`, mounted by `index.ts`. Public surfaces and import paths are unchanged.

## 3.8.6

### Patch Changes

- f4b9c6b: Upgrade oxlint to 1.70; satisfy tightened vitest rules — add toThrow messages and fix standalone-expect in test suites
- Updated dependencies [f4b9c6b]
  - @osn/db@0.17.2
  - @shared/crypto@0.8.3

## 3.8.5

### Patch Changes

- Updated dependencies [5d6a97c]
  - @shared/observability@0.11.1
  - @shared/crypto@0.8.2
  - @shared/email@0.3.1
  - @shared/turnstile@0.2.1

## 3.8.4

### Patch Changes

- 5add635: Handle prefix search for co-host autocomplete.

  - `@osn/db`: add a B-tree index on `users.handle` (`users_handle_idx`) to back
    left-anchored `LIKE 'prefix%'` scans, with forward-only migration
    `0001_exotic_lady_vermin.sql`. DEPLOY: this migration must be applied to
    osn-db-prod manually at deploy time — it is NOT in CI's `deploy.yml`
    (`bun run --cwd osn/db db:migrate:prod`).
  - `@osn/api`: new ARC-gated `GET /graph/internal/profile-search?prefix=&limit=`
    (scope `graph:read`, audience `osn-api`, same guard as the sibling internal
    endpoints). Normalises the prefix like `profile-by-handle` (strips `@`,
    lowercases), requires a minimum prefix length of 2 (returns an empty list,
    not an error, below it), excludes tombstoned/soft-deleted accounts
    (`deletedAt IS NULL`), escapes `LIKE` wildcards in the user input, orders by
    handle, and hard-caps results at 10 (default 8). Returns
    `{ profiles: [{ id, handle, displayName, avatarUrl }] }`.

- Updated dependencies [5add635]
  - @osn/db@0.17.1
  - @shared/crypto@0.8.1

## 3.8.3

### Patch Changes

- 59a1dab: Raise the per-IP rate limits on the auth endpoints that legitimately auto-fire,
  which were tripping a 429 on normal sign-in. `passkey_login_begin` is fired by
  the passkey **conditional-UI / autofill** ceremony on every login-page load, and
  `handle_check` fires as-you-type during registration — both were capped at
  10/min/IP, which a couple of page reloads exhausted. New per-IP/60s tiers:
  `passkey_login_begin` 10 → **60**, `passkey_login_complete` 10 → **20**,
  `handle_check` 10 → **30** (native Workers binding tiers + the local in-memory
  mirror). The security-relevant gates (`register_complete`, `*_complete`,
  step-up, recovery, email-change) are unchanged — begin is cheap and completion
  still requires a valid assertion.

## 3.8.2

### Patch Changes

- c261a5f: Fix two auth-path bugs that only surfaced on the deployed Cloudflare Worker
  (workerd).

  - **Bug A — `/graph/internal/register-service` + `/service-keys/:keyId` 500
    ("crypto.timingSafeEqual is not a function").** The `INTERNAL_SERVICE_SECRET`
    bearer check compared the header with the GLOBAL `crypto` (Web Crypto), which
    has no `timingSafeEqual` on workerd, so the compare threw and the request
    500'd — blocking the cire→osn ARC key registration (the "add hosts by handle"
    feature). The compare now uses a new workerd-safe `timingSafeEqualString`
    helper (`osn/api/src/lib/timing-safe.ts`) backed by `node:crypto`
    (`nodejs_compat`), keeping the constant-time property and the length-mismatch
    guard. `osn/api/src/services/auth.ts` now reuses the same shared helper
    instead of its private copy.

  - **Bug B — organiser "Security → add a passkey" returned 401 "unauthorized".**
    `/passkey/register/{begin,complete}` resolved the enrol principal by requiring
    the client to echo a `body.profileId` exactly equal to the access token's
    `sub`. When the client's notion of the active profile drifted from the token's
    `sub` (e.g. after a silent token refresh re-issues the access token for the
    account's default profile), this produced a spurious 401. The principal is now
    resolved from the access token's OWN verified `sub` (the same pattern
    `/step-up/passkey/*` already uses), so enrolment always binds to the caller's
    own account; the client-supplied `profileId` is no longer a trust input and a
    foreign `profileId` can never redirect enrolment onto another account.

  - **Bug C — organiser login looped back to login once Turnstile was enabled.**
    `/login/passkey/begin` is hit by TWO frontend paths: the interactive
    identifier-bound form (renders the Turnstile widget, carries a token) and the
    silent conditional-UI / passkey-autofill ceremony (NO identifier, NO token, by
    design). With Turnstile configured the gate fail-closed on EVERY caller, so the
    autofill path — the common way passkey users sign in — got `turnstile_failed`
    and bounced back to login. The gate now fires only when a non-empty
    `identifier` is present (the interactive form); the no-identifier conditional-UI
    ceremony is exempt — it discloses nothing account-specific, still requires a
    valid passkey assertion to complete, and stays per-IP rate-limited.

## 3.8.1

### Patch Changes

- d541a79: ops: email is now required in prod (Resend delivery confirmed from hello@cireweddings.com) — removed the `OSN_EMAIL_OPTIONAL` degraded opt-in from osn-api's production vars, so osn-api fails closed at startup if `RESEND_API_KEY` is ever absent rather than silently dropping OTP/security mail. Also activated the Cloudflare Turnstile sitekey in the cire/web + cire/organiser Pages builds (`deploy.yml`), reading the `PUBLIC_TURNSTILE_SITEKEY` repo Variable; the matching `TURNSTILE_SECRET_KEY` is set on the osn-api + cire-api Workers (sitekey-first rollout so the gate never blocks before the widget is live).

## 3.8.0

### Minor Changes

- 0880d75: Add Resend as osn-api's preferred transactional-email transport.

  `@shared/email` gains `ResendEmailLive` (`makeResendEmailLive`) — POSTs to Resend's HTTP API (`https://api.resend.com/emails`, bearer-authed), works on workerd with no paid Workers plan. It reuses the exact template/render path of `CloudflareEmailLive` and matches its instrumented-fetch, span, metric, and non-2xx → tagged-failure semantics (429 → `rate_limited`, other non-2xx → `dispatch_failed`, fetch reject → `api_unreachable`). The `RESEND_API_KEY` is placed only in the `Authorization` header — never in a URL, span/metric attribute, log, or `EmailError.cause`.

  `osn/api`'s `selectEmailLayer` now prefers Resend: precedence is **Resend → Cloudflare (legacy fallback) → local Log → `OSN_EMAIL_OPTIONAL` Noop → throw**. `RESEND_API_KEY` is added to the Worker `Env` type. Key-optional / non-breaking: with no key, behaviour is exactly as before. With Resend configured, `OSN_EMAIL_OPTIONAL` is no longer needed (a future Resend outage then fails closed like any normal misconfig).

### Patch Changes

- Updated dependencies [0880d75]
  - @shared/email@0.3.0

## 3.7.0

### Minor Changes

- 44b0982: Add an ARC-gated internal endpoint `GET /graph/internal/profile-by-handle` that
  resolves an OSN handle (e.g. `@alice`) to its profile id (plus handle +
  display name), or 404. Requires audience `osn-api` + scope `graph:read`, mirrors
  the existing `/profile-account` route, and applies the same tombstone rule (a
  soft-deleted account is invisible during the grace window). Handle input is
  normalised (strips a leading `@`, lowercases) before the exact-match lookup.

  Consumed by cire to turn an organiser-typed handle into a `usr_*` id when adding
  a wedding co-host — cire has no other way to map a handle to a profile id.

- 5055e1a: OSN core auth hardening (W6):

  - **O1 — issuer pinning + clock tolerance.** Access and step-up JWTs are now
    signed with `iss = AuthConfig.issuerUrl` and verified with `issuer` pinned +
    a 30s `clockTolerance` at every verify site (local signer + verifier half;
    the downstream `@shared/osn-auth-client` verifier is W7). Rollout is
    verifier-first: the tolerant verifier must deploy before the signer enforces
    `iss`.
  - **O2 — recovery-code per-account lockout.** `consumeRecoveryCode` now counts
    failed attempts keyed on the RESOLVED accountId (threshold 5, 15-min
    lockout), Redis-backed with an in-memory fallback. Lockout returns the same
    generic error (no enumeration oracle), writes a `recovery_code_lockout`
    security-event row, and resets on success. Unknown identifiers never lock a
    victim.
  - **O3 — full Redis ceremony-store epic.** Every process-local ceremony /
    pending-state store (registration + login + step-up challenges, pending
    registrations, step-up OTP, pending email changes, cross-device requests) now
    has an injectable Redis-backed implementation alongside the in-memory default,
    plus the two per-account caps (profile-switch, email-change-begin) routed
    through the rate-limiter family. New `RedisNamespace` metric union in
    `@shared/redis` and per-namespace store telemetry.
  - **O4 — passkey-register cookieless fix.** `completePasskeyRegistration` now
    invalidates ALL account sessions (with a logged anomaly + invalidation
    metric) when no caller session is resolvable, instead of silently skipping
    H1 invalidation.
  - **O5 — randomised enumeration-probe sentinels.** The fixed `acc_enum_probe` /
    `__nonexistent__` burn-in keys are now per-request random non-matching ids.

  `@shared/observability` adds the `recovery_code_lockout` security-event kind.

- dbed689: Rate-limit + IP-trust hardening for osn-api behind Cloudflare.

  - **Client-IP trust (security fix):** the non-local Workers runtime now keys per-IP rate limiting on `cf-connecting-ip` exclusively (`trustCloudflare: true`), never the spoofable `x-forwarded-for`. This closes the bypass where an attacker forged XFF to rotate past the per-IP auth limits. Local Bun dev keeps socket-peer keying; `TRUSTED_PROXY_COUNT` is now ignored in deployed tiers. Unresolved IPs still deny (429), never bucket-share.
  - **Native Workers rate limiting:** the 60-second-window per-IP auth limiters move off Upstash onto the Cloudflare Workers native Rate Limiting binding (global + atomic at the edge, fail-closed). The three 1-hour-window per-IP limiters (recovery generate/complete, email-change-begin), every per-user/per-account limiter, and every stateful store stay on Upstash. `createWorkersRateLimiter` + `WorkersRateLimitBinding` are now shared from `@shared/rate-limit`.
  - **Workers observability:** `[observability]` enabled in `osn/api/wrangler.toml` (and every named env) so Workers Logs/invocations are captured in the Cloudflare dashboard.

  Per-colo trade-off accepted: native rate limiting is counted per Cloudflare location, not globally. osn-api must be redeployed for the new bindings + observability to take effect.

- 5aa1594: osn-api runs on Cloudflare Workers (`export default { fetch, scheduled }`).

  `osn/api/src/index.ts` is now the workerd entry, mirroring cire's proven
  template: a per-isolate `cached` app, fail-closed 503 on missing
  bindings/vars, everything built from the request-scoped `env` binding (not
  module-top `process.env`), and a cron `scheduled` handler that runs the
  account-erasure fan-out-retry + hard-delete sweeps (replacing the Bun
  `setInterval`). The Bun dev server moved into `src/local.ts` and is unchanged
  in behavior (default `bun run dev`); a runtime-agnostic `src/build-deps.ts`
  holds the shared composition both entries call.

  Highlights:

  - S-L1: the Workers Redis path env-gates the in-memory fallback — a deployed
    Worker (`OSN_ENV` set & != "local") with missing Upstash bindings fails
    closed at construction instead of silently downgrading rate-limiters /
    step-up-jti to per-isolate in-memory.
  - P-I3: the Upstash client + Effect runtime + Elysia app are built once per
    isolate and cached, never reconstructed in the request path.
  - S-H3: the Workers entry re-applies the `x-request-id` sanitize-and-echo the
    omitted observability plugin used to do.
  - Secrets (`INTERNAL_SERVICE_SECRET`, `PULSE_API_URL`/`ZAP_API_URL`) are
    threaded through `env`/the `createApp` factory instead of module-top
    `process.env` reads, since workerd surfaces secrets only on `env`.
  - `createApp` gains an `aot` flag (Workers passes `false`; AOT's `new
Function` is forbidden on workerd) and keeps `includeObservabilityPlugin:
false` + the redacting `osnLoggerLayer` on the Workers path.

  `@osn/db` / `@shared/db-utils`: `DbLive`'s bun:sqlite path is resolved lazily
  (`makeDbLive` now accepts a path thunk) so `fileURLToPath(import.meta.url)` no
  longer runs at module load — it threw on workerd, where `import.meta.url` is
  undefined, even though the Workers path never builds the bun:sqlite layer.

  wrangler.toml gains `main`, the real per-env D1 ids, per-env `[vars]`, and a
  6-hourly `[triggers] crons` for the sweeper. New devloop scripts: `dev`
  (unchanged fast Bun loop), `dev:wrangler` (workerd + local D1 + in-memory
  Redis, no external services), `deploy`, `types`, `build`.

- aed9d98: Add a Workers-compatible Upstash REST Redis backend (migration Phase 2).

  `@shared/redis` now ships three interchangeable `RedisClient` backends behind
  the same interface, split so the Workers bundle never statically imports
  `ioredis` (which needs Node `net`/`tls` sockets and cannot run on workerd):

  - **ioredis split to a subpath.** `wrapIoRedis`, `createClientFromUrl`,
    `ConnectableRedisClient`, and the Effect `RedisLive` layer moved to a new
    `@shared/redis/ioredis` subpath export. The top-level `@shared/redis` entry
    now exports only the `RedisClient` interface, the in-memory client, and the
    new Upstash client — no static `ioredis` import in its graph.
  - **Upstash adapter.** New `@shared/redis/upstash` with `wrapUpstash(redis)`
    and `createUpstashClient({ url, token })`. `createUpstashClient` sets
    `automaticDeserialization: false` so `get` returns raw strings (matching
    ioredis and the rotated-session-store's opaque family-id round-trips); `set`
    maps `pxMs` to `{ px }`; `eval` passes the script/keys/args straight through
    (preserving numeric returns for the rate-limit Lua and the `1`/`"1"` step-up
    jti check); `quit` is a no-op for the stateless REST transport.

  `@osn/api` gains `initRedisClientFromEnv(env)` — a synchronous, ioredis-free,
  side-effect-free selector that returns `createUpstashClient(...)` when both
  `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are present on the
  Workers `env` binding, else an in-memory client. It performs no startup health
  check, has no `REDIS_REQUIRED` fail-closed mode, and never calls
  `process.exit` — those stay on the Bun `initRedisClient` path, which is
  unchanged. Consumers (rate limiters, rotated-session/step-up/ceremony stores)
  remain backend-agnostic; no call sites changed.

- d81383d: Add Cloudflare Turnstile bot protection to the OSN auth surface (key-optional, fail-closed).

  New `@shared/turnstile` package exposes `createTurnstileVerifier(secret?)` — a key-optional, fail-closed siteverify helper. When the `TURNSTILE_SECRET_KEY` secret is **unset** the verifier is `null` and every gate is skipped (flows behave exactly as before — safe to merge before the widget exists). When **set**, it POSTs the token to Cloudflare's managed `siteverify` endpoint via `instrumentedFetch`, passing the caller's `cf-connecting-ip` as `remoteip`, and rejects on any missing / invalid / expired / duplicate (single-use) token or unreachable endpoint. The secret is never logged or returned to the client.

  - **`@osn/api`**: `/register/begin` and `/login/passkey/begin` are gated. The verifier is built once per isolate in `build-deps.ts` from `env.TURNSTILE_SECRET_KEY` and threaded through `createAuthRoutes`; a configured gate fails closed with `400 turnstile_failed`. New bounded metric `osn.auth.turnstile.rejected{endpoint}`.
  - **`@osn/client`**: `RegistrationClient.beginRegistration` and `LoginClient.passkeyBegin` accept an optional `turnstileToken`, sent on the begin call (omitted cleanly when absent — the no-Turnstile call shape is unchanged, and the silent conditional-UI passkey ceremony carries no token).
  - **`@osn/ui`**: new `TurnstileWidget` (Solid) renders Cloudflare's widget only when a `siteKey` prop is provided (lazy-loads `api.js`, `data-action="turnstile-spin-v1"`); `Register` + `SignIn` take an optional `turnstileSiteKey` prop and gate submit on a solved challenge. Omitted ⇒ no widget, no gate.

  The sitekey is public (embedded in client HTML at build time via `PUBLIC_TURNSTILE_SITEKEY`); the secret is a `wrangler secret` on osn-api. Both halves are optional and graceful, mirroring the maps-embed key and `OSN_EMAIL_OPTIONAL` precedents.

### Patch Changes

- 892fe3e: Wire the `cireweddings.com` custom domain into osn-api's production config. OSN
  identity runs under the cireweddings.com zone for now (a dedicated OSN domain is
  deferred). In `osn/api/wrangler.toml` `[env.production]`:

  - `OSN_RP_ID = "cireweddings.com"` — the WebAuthn RP ID is the registrable apex
    shared by the organiser portal (`app.cireweddings.com`), the only prod passkey
    surface. Prod passkeys are now UNBLOCKED (previously deferred pending a domain).
  - `OSN_ORIGIN = "https://app.cireweddings.com"` — the organiser portal is the
    passkey origin.
  - `OSN_ISSUER_URL = "https://id.cireweddings.com"` (JWT `iss`).
  - `OSN_CORS_ORIGIN = "https://app.cireweddings.com"` — only the organiser portal
    calls osn-api; an empty list throws at boot.
  - `OSN_EMAIL_FROM = "noreply@cireweddings.com"`.
  - A custom-domain route `[[env.production.routes]]` (`pattern =
"id.cireweddings.com"`, `custom_domain = true`) serving the Worker on
    `id.cireweddings.com` — auto-provisions DNS + cert since the zone is in-account.

  Config-only; no app logic changed. dev/staging keep their current config. Validated
  with `wrangler deploy --env production --dry-run`.

- 7c7fab4: Refactor osn/api into a pure `createApp` factory + a Bun dev entry, with no
  behaviour change (Phase 1 of the Cloudflare Workers migration).

  - `src/app.ts` exports `createApp(deps)` — the Elysia route composition,
    verbatim — taking an explicit `AppDeps` struct (auth config, cookie config,
    CORS origins, origin guard, rate limiters, stores, layers, shared
    `appRuntime`). It never reads `process.env`.
  - `src/local.ts` owns all env-driven Bun wiring: `buildAppDeps()` loads the JWT
    key pair, validates the session-IP pepper, initialises Redis-backed stores +
    rate limiters, selects the email transport, and builds the Effect layer graph
    ONCE into a shared `ManagedRuntime`; `startBunServer()` keeps the
    `app.listen`, ephemeral-key warning, outbound ARC key rotation, and the
    account-erasure sweeper.
  - `src/index.ts` stays the Bun composition entry tests import: it calls
    `buildAppDeps()` + `createApp()`, still exports `app`, and still conditionally
    listens off `NODE_ENV`.

  Redis/ioredis, observability, and the Workers `fetch` entry are untouched —
  they belong to later phases.

- f2c1351: Allow osn-api to boot in non-local environments WITHOUT Cloudflare email as an explicit opt-in.

  By default osn-api still fails closed at startup when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` are absent in a non-local env. Setting the new non-secret boolean `OSN_EMAIL_OPTIONAL=true` now lets it boot with a no-op email transport (`makeNoopEmailLive` in `@shared/email`) that discards transactional mail and emits a loud, redacted startup warning instead of throwing. Cloudflare creds always win when present. Transport selection is centralised in `osn/api/src/lib/email-layer.ts` (shared by the Bun and Workers entries).

- 4d44795: Fix: register osn's outbound ARC public key with Pulse/Zap on the Cloudflare
  Workers path before the account-erasure deletion fan-out.

  Pulse + Zap verify osn's inbound ARC tokens against a **pre-registered** public
  key (kid → registered key; no JWKS-by-kid pull). The Bun server registers that
  key at boot via `startOutboundKeyRotation` (`local.ts`), but the workerd
  `scheduled` handler — which runs the deletion fan-out and mints `account:erase`
  ARC tokens — never did. The first `/internal/account-deleted` POST would be
  401'd by the downstream and the GDPR Art. 17 erasure would stall (P6 finding).

  The `scheduled` handler now calls a new `registerOutboundKeysOnce` (reusing the
  existing `registerWithDownstream` logic) **before** the fan-out sweeps,
  registering once per isolate (a module latch suppresses re-POSTing on later cron
  ticks; the downstream upsert is idempotent regardless). A registration failure
  is logged via `Effect.logError` and swallowed so a transient downstream outage
  never aborts the cron — the latch only flips on full success, so the next tick
  retries. The misleading "lazily inits on first outbound use" comment in
  `src/index.ts` is corrected. No change to the Bun path.

- 8af4c92: Add a workerd-safe, logger-only observability layer to `@osn/api` so the
  eventual Cloudflare Workers entry never imports `@effect/opentelemetry/NodeSdk`
  (Node-only, won't run on workerd).

  - New `osn/api/src/observability.ts` mirrors `cire/api`'s: exports
    `osnLoggerLayer` (built via `makeLoggerLayer(loadConfig({ serviceName: "osn-api" }))`,
    importing only the effect-only `@shared/observability/config` + `/logger`
    subpaths) plus `runOsn` / `runOsnSync` helpers. It deliberately never calls
    `initObservability` / `makeTracingLayer`, which pull the Node OTel SDK. Typed
    `Layer.Layer<never>`, so it is interchangeable with the full layer in the app
    runtime / route signatures.
  - `createApp` (`app.ts`) gains an `includeObservabilityPlugin: boolean` deps
    flag. The Elysia `observabilityPlugin` calls `process.hrtime.bigint()` on the
    per-request hot path (start timestamp + duration), which is not available on
    workerd without `nodejs_compat`; the flag lets the Workers path omit it while
    keeping `healthRoutes` + the redacting logger. The Bun path passes `true` —
    no behaviour change.

- 5055e1a: Harden client-IP resolution for rate limiting (S-M34).

  `getClientIp` now accepts an optional `ClientIpOptions { trustedProxyCount?, trustCloudflare?, socketIp? }` and resolves the keying IP under an explicit trust policy that **fails closed**:

  - `trustCloudflare` → trust `cf-connecting-ip` only (never falls back to `x-forwarded-for`); missing/invalid → unresolved.
  - `trustedProxyCount > 0` → take the entry N-from-the-right of `x-forwarded-for` (spoofing-resistant); missing/short/malformed → unresolved.
  - otherwise (direct/dev) → trust the transport socket peer (`socketIp`) only; absent/invalid → unresolved.

  New exports: `UNRESOLVED_IP`, `isUnresolvedIp(ip)`, `isValidIp(value)`, and the `ClientIpOptions` type. The legacy no-options call form (`getClientIp(headers)`) is preserved and marked `@deprecated` — it keeps the old left-most-XFF / `"unknown"` behaviour so consumers can migrate incrementally; the hardened behaviour is opt-in via the options argument.

  `@osn/api` adopts the hardened path at its auth + profile rate-limit call sites: the composition root reads `TRUSTED_PROXY_COUNT` (validated integer, default 0 = direct/socket-peer mode), wires Bun's `server.requestIP` as `socketIp`, and emits a startup warning when a non-local deploy leaves it unset. Requests whose IP is unresolved are denied (429) rather than sharing a single bucket. Session-IP persistence uses the same resolved IP.

- 5055e1a: Harden shared crypto / auth-client issuer handling (W7).

  - `@shared/crypto` `verifyArcToken` gains an optional `expectedIssuer` argument
    (X1). When set, jose enforces the signed `iss`, cryptographically binding the
    token issuer to the `kid`→issuer DB mapping. The OSN ARC middleware now passes
    the peeked issuer so a token whose `iss` differs from its `kid`'s registered
    service is rejected at verification time. Pulse's in-memory ARC receiver
    passes the registered issuer too (its explicit post-verify `iss` check is kept
    as defence-in-depth). Backward compatible — omitting the argument leaves `iss`
    unenforced.
  - ARC token cache key now includes the requested `ttl` and a canonicalised
    scope (X3), so a token requested with a shorter TTL never reuses a
    longer-lived cached entry and formatting-only scope differences collapse onto
    one entry. Scope is not sorted (differing scope order stays distinct, matching
    the signed claim).
  - The ARC public-key cache TTL is now overridable via
    `ARC_PUBLIC_KEY_CACHE_TTL_SECONDS` (default 300), bounding the cross-process
    key-revocation window (X4).
  - `@shared/osn-auth-client` `extractClaims` / `osnAuth` adapters gain an optional
    `issuer` option and apply a 30s `clockTolerance` (X2). Issuer is optional and
    unset by default for rollout safety — when unset, `iss` is not enforced so
    pre-issuer-stamping access tokens still verify. An issuer mismatch is terminal
    (no JWKS refetch).
  - `@shared/redis` in-memory client `eval` now asserts it is only ever handed the
    rate-limit Lua script (X5), so a future, semantically-different script cannot
    silently inherit fixed-window rate-limit behaviour.

- Updated dependencies [5055e1a]
- Updated dependencies [dd2dad3]
- Updated dependencies [f2c1351]
- Updated dependencies [dbed689]
- Updated dependencies [5aa1594]
- Updated dependencies [aed9d98]
- Updated dependencies [130e6c5]
- Updated dependencies [5055e1a]
- Updated dependencies [5055e1a]
- Updated dependencies [d81383d]
  - @shared/redis@0.4.0
  - @shared/observability@0.11.0
  - @osn/db@0.17.0
  - @shared/email@0.2.7
  - @shared/rate-limit@0.3.0
  - @shared/db-utils@0.3.1
  - @shared/crypto@0.8.0
  - @shared/turnstile@0.2.0

## 3.6.0

### Minor Changes

- f466a65: Migrate Pulse and the OSN core DB layer onto the four-environment database story
  (local bun:sqlite / dev·staging·prod D1). D1 has no interactive transaction, so
  every `db.transaction(async tx => …)` is rewritten to the shared `commitBatch`
  helper — an atomic `db.batch([...])` on D1, sequential awaited writes on
  bun:sqlite — preserving all-or-nothing semantics on the deployed driver.

  `@pulse/api`: 5 account-erasure transactions → `commitBatch`; `createApp`
  factory (`aot: false`) + `local.ts` (Bun.serve) + Workers `index.ts` (D1) +
  `wrangler.toml` (dev/staging/production) + a Miniflare integration test.

  `@osn/api`: all 17 transactions across auth / profile / graph / organisation /
  account-erasure → `commitBatch`, preserving the S-H1/S-M2 atomicity invariants
  (UNIQUE-constraint guards for handle/email races; a count-guarded conditional
  DELETE for the last-passkey invariant). Adds a Miniflare integration test and a
  `wrangler.toml` for D1 migration tooling. NOTE: full Workers _hosting_ of
  osn-api remains gated on replacing ioredis with a Workers-compatible Redis —
  its DB layer is D1-ready but it still runs only as the Bun.serve `local` host.

  `@pulse/db` / `@osn/db`: broadened service `Db` type + `makeDbD1Live`,
  schema-reflection `./testing` export, and wrangler-based `db:migrate:*` scripts.

### Patch Changes

- Updated dependencies [f466a65]
- Updated dependencies [f466a65]
  - @shared/db-utils@0.3.0
  - @osn/db@0.16.0
  - @shared/crypto@0.7.1

## 3.5.2

### Patch Changes

- 87b2f75: Build the application layer graph once into a shared `ManagedRuntime` instead
  of re-providing `DbLive` + the observability layer inside every request's
  `Effect.runPromise`. The old per-request pattern restarted and tore down the
  whole OpenTelemetry NodeSdk (and opened a fresh SQLite connection) on each
  call; the teardown's exporter flush stalled interactive endpoints by ~3s
  locally — most visibly the debounced username-availability check
  (`GET /handle/:handle`). All nine route factories now run handlers against the
  single process-wide runtime (tests wrap their layer in a one-time runtime),
  eliminating the per-request rebuild.

  Also lightens the handle-availability check itself: it now runs a single-column
  `users.handle` existence probe instead of `findProfileByHandle`, which joined
  `accounts` to hydrate an email the check discarded.

## 3.5.1

### Patch Changes

- af2cf69: Bring cire under the OSN oxlint + oxfmt conventions cleanly — cire was the
  source of 34 of the repo's 40 oxlint warnings; it is now warning-free under
  the shared `oxlintrc.json`.

  Lint fixes (behaviour-preserving):

  - `unicorn/no-array-sort` — replaced mutating `Array#sort()` with
    non-mutating `Array#toSorted()` in test assertions across `cire/api`
    (`claim`, `rsvp`, `spreadsheet` service + route tests).
  - `unicorn/prefer-add-event-listener` — `FileReader`/`script` `on*`
    assignments converted to `addEventListener(...)` in
    `cire/organiser` `ImportPanel`, `cire/web` `PinterestBoard`, and the
    `cire/web` calendar test.
  - `unicorn/consistent-function-scoping` — hoisted scope-independent
    helpers (`pad` in `cire/web/calendar`, `tooManyRows` / `cellTooLarge`
    in `cire/api/spreadsheet`) to module scope.
  - `no-console` — annotated the `cire/api` local-dev server banner
    (`local.ts`, a Bun shim, not the deployed Worker) with the repo's
    standard `eslint-disable-next-line no-console -- …` justification.

  Tooling parity:

  - The root `fmt` / `fmt:check` scripts now include `cire` (the `lint`
    script already covered it via `.`), so CI's format check enforces cire
    too. The two cire `astro.config.mjs` files were import-sorted to match.

  Also cleared the remaining 6 repo-wide oxlint warnings so the whole tree
  is warning-free under the shared config:

  - `@pulse/api` events feed — `Array#sort()` → `Array#toSorted()`.
  - `@pulse/app` Explore — hoisted `isDark` to module scope
    (`consistent-function-scoping`) and prefixed an unused mock param.
  - `@osn/api` outbound-arc + `@shared/osn-auth-client` jwks-cache test —
    justified `no-await-in-loop` disables where the sequential `await` is
    intentional (short-circuit on a configured stack / LRU access order
    under test), plus a hoisted test url helper.

- 04e0bf2: Audit + align cross-workspace dependency ranges and adopt TypeScript 6.0.

  - Resolve declared-range drift: `solid-js` → `^1.9.13` and `vitest` → `^4.1.8`
    everywhere they were behind; `@osn/landing` switched from pinned
    `astro@6.1.10` / `@astrojs/solid-js@6.0.1` to the caret ranges (`^6.4.2` /
    `^6.0.1`) used by the cire Astro apps.
  - Bump `typescript` `^5.9.3` → `^6.0.3` across the repo. The shared tsconfig was
    already TS 6.0-clean (`strict: true`, `target` ≥ ES2015, ESNext modules, no
    removed flags), so no `ignoreDeprecations` shim was needed. Three call sites
    surfaced by the stricter compiler were fixed:
    - `@osn/social`: added the missing `src/vite-env.d.ts`
      (`/// <reference types="vite/client" />`) so side-effect CSS imports type
      again (TS2882).
    - `@pulse/api`: dropped the now-deprecated `baseUrl` from `tsconfig.json`
      (the `#db` / `#routes` `paths` are already tsconfig-relative; TS5101).
    - `@pulse/api`: annotated `createClient`'s return type as
      `Treaty.Create<App>` to satisfy the tightened declaration-portability check
      (TS2883).

- 1bb4270: Dev auth ergonomics for the multi-frontend monorepo:

  - `OSN_ORIGIN` now accepts a comma-separated list of accepted WebAuthn origins
    (parsed in `index.ts`; `AuthConfig.origin` widened to `string | string[]` and
    passed straight to `@simplewebauthn`'s `expectedOrigin`). Lets pulse (1420),
    social (1422), cire organiser (4322) and the SDK example (5173) all run passkey
    ceremonies against one OSN API. Backward compatible — a single origin still
    works.
  - Local-only OTP visibility: registration / step-up / email-change now emit a
    debug log of the OTP code, gated strictly on a local environment (`OSN_ENV`
    unset or `"local"`). Never logs in staging/production. Makes email-OTP dev
    flows testable without a real inbox (the `LogEmailLive` transport records the
    body but deliberately never logs the code).

- Updated dependencies [d04dc20]
- Updated dependencies [77f91a4]
- Updated dependencies [04e0bf2]
- Updated dependencies [940561f]
  - @shared/crypto@0.7.0
  - @shared/observability@0.10.1
  - @osn/db@0.15.1
  - @shared/email@0.2.6
  - @shared/rate-limit@0.2.2
  - @shared/redis@0.3.1

## 3.5.0

### Minor Changes

- c3cca40: Account deletion compliance (C-H2 / GDPR Art. 17).

  Two flows:

  - **Flow A — full OSN account delete.** New `DELETE /account` on osn-api with step-up gate, 7-day soft-delete grace + manual fast-track, ARC fan-out to currently-enrolled apps, hard-delete sweeper.
  - **Flow B — leave Pulse.** New `DELETE /account` on pulse-api with step-up verification round-trip to osn-api. Hosted events flip into a 14-day public cancellation window before hard-delete (audience commitment, independent of the 7-day account grace).

  Schema additions:

  - `osn/db`: `accounts.deleted_at`, `accounts.processing_restricted_at`, new `app_enrollments` (modular-platform opt-in tracking) and `deletion_jobs` (in-flight tombstones with per-bridge `*_done_at`).
  - `pulse/db`: `events.cancelled_at` / `hard_delete_at` / `cancellation_reason`, new `pulse_deletion_jobs`.

  Other surfaces:

  - New step-up token `purpose` claim (`account_delete`, `pulse_app_delete`) — confused-deputy guard for cross-service flows.
  - New osn-api internal endpoints: `/internal/step-up/verify`, `/internal/app-enrollment/{join,leave}`. ARC scopes `step-up:verify`, `app-enrollment:write`, `account:erase` added to the register-service allowlist.
  - Pulse becomes an ARC verifier (in-memory key registry + `/internal/register-service`) and an ARC issuer for the leave-app callback.
  - New observability: `osn.account.deletion.{requested,completed,duration,fanout,fanout_pending_age}`, `osn.account.app_enrollment.{joined,left}`, `pulse.account.deletion.*`, `pulse.events.host_cancelled[.hard_delete]`.
  - New `osn/client` SDK methods: `deleteAccount`, `cancelAccountDeletion`, `getAccountDeletionStatus`.

### Patch Changes

- Updated dependencies [c3cca40]
  - @osn/db@0.15.0
  - @shared/observability@0.10.0
  - @shared/crypto@0.6.12
  - @shared/email@0.2.5

## 3.4.1

### Patch Changes

- 2420fc8: Add http://localhost:4322 (@cire/organiser) to the local-dev CORS
  fallback so the organiser portal's OSN passkey sign-in works
  out-of-the-box.
- Updated dependencies [9f6874b]
  - @shared/observability@0.9.2
  - @shared/crypto@0.6.11
  - @shared/email@0.2.4

## 3.4.0

### Minor Changes

- dd742dd: Pulse first-run onboarding: six-step `/welcome` flow with themed coral illustrations (welcome rings, editorial map, interest constellation, location pin drop, notifications ember, finish date stamp). Captures interests, location/notifications permissions, and reminder opt-in. Account-keyed server-side via a new `pulse_account_onboarding` table + `pulse_profile_accounts` mapping cache + new `GET /graph/internal/profile-account` ARC endpoint on `osn/api` — preserves the multi-account privacy invariant (accountId never on the wire). Server-side first-run gate redirects new users to `/welcome` and is idempotent on the completion POST. See `wiki/systems/pulse-onboarding.md`.

## 3.3.2

### Patch Changes

- 073238d: Migrate close friends from OSN core to Pulse.

  Close friends is now a Pulse-scoped feature, not an OSN core feature. Each OSN
  app can implement its own close-friends-style list against the OSN connection
  graph; OSN core retains only `connections` and `blocks`.

  What it does in Pulse:

  - **Feed boost.** Events organised by a close friend surface higher in
    `listEvents` (stable partition: chronological order preserved within each
    bucket; not applied for anonymous viewers).
  - **Hosting affordance.** The existing RSVP avatar ring — driven by an
    attendee having marked the viewer as a close friend — is preserved end-to-end,
    now backed by the local `pulse_close_friends` table.
  - **Management UI.** New `/close-friends` page in `@pulse/app` (linked from the
    header avatar dropdown).

  Surface changes:

  - New: `pulse_close_friends` table in `@pulse/db`; Effect service + four CRUD
    routes (`GET/POST/DELETE /close-friends/...`) in `@pulse/api`; metrics
    `pulse.close_friends.{added,removed,listed,list.size,batch.size}`.
  - Removed: OSN-core `close_friends` table, services, routes (user-facing
    `/graph/close-friends/*` and internal `/graph/internal/close-friends*`),
    graph close-friend SDK methods on `@osn/client`, the close-friends tab in
    `@osn/social` ConnectionsPage, the `withGraphCloseFriendOp` metric helper,
    and the `GraphCloseFriendAction` observability attribute.
  - Connection projection now includes `id` so cross-DB references (Pulse adding
    by profile id) work without duplicating handle→id resolution.

  Pre-launch: the OSN `close_friends` table is dropped outright; seed data
  updated. No migration path or backwards-compatibility shims.

- Updated dependencies [073238d]
  - @osn/db@0.14.2
  - @shared/observability@0.9.1
  - @shared/crypto@0.6.10
  - @shared/email@0.2.3

## 3.3.1

### Patch Changes

- Updated dependencies [9de67a2]
  - @shared/observability@0.9.0
  - @shared/crypto@0.6.9
  - @shared/email@0.2.2

## 3.3.0

### Minor Changes

- ac7312b: Add cross-device login: QR-code mediated session transfer allowing authentication on a new device by scanning a QR code from an already-authenticated device.

### Patch Changes

- Updated dependencies [ac7312b]
  - @shared/observability@0.8.1
  - @shared/email@0.2.1
  - @shared/crypto@0.6.8

## 3.2.0

### Minor Changes

- d431e9d: Switch email transport from Worker-proxy to Cloudflare Email Service REST API.

  `@shared/email` `CloudflareEmailLive` now POSTs directly to `https://api.cloudflare.com/client/v4/accounts/{id}/email-service/send` with a bearer token. Removes the ARC-token-signing intermediary and the `@shared/crypto` dependency. Error reason `worker_unreachable` renamed to `api_unreachable`.

  `@osn/email-worker` is deleted — the Cloudflare Worker middleman is no longer needed since the REST API is available from any runtime, not just Workers.

  `@osn/api` replaces `OSN_EMAIL_WORKER_URL` with `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` env vars.

### Patch Changes

- Updated dependencies [d431e9d]
  - @shared/email@0.2.0

## 3.1.1

### Patch Changes

- 92e9486: Fix CORS blocking handle checks and passkey flows from Tauri apps in local dev. `OSN_CORS_ORIGIN` now falls back to the actual monorepo frontend ports (`http://localhost:1420` for `@pulse/app`, `http://localhost:1422` for `@osn/social`) instead of the WebAuthn example-app origin (`5173`). Non-local envs still require `OSN_CORS_ORIGIN` to be set explicitly.

## 3.1.0

### Minor Changes

- 31957b4: In-range minor bumps:

  - `effect` 3.19.19 → 3.21.2 (11 workspaces)
  - `elysia` 1.2.0 → 1.4.28 + `@elysiajs/eden` 1.2.0 → 1.4.9
  - `@simplewebauthn/server` 13.1.1 → 13.3.0
  - `ioredis` 5.6.0 → 5.10.1
  - `happy-dom` 20.8.4 → 20.9.0
  - `better-sqlite3` 12.5.0 → 12.9.0 (SQLite 3.51.1 → 3.53.0)
  - OpenTelemetry stable cluster 2.0.0 → 2.7.0 (`resources`, `sdk-metrics`, `sdk-trace-base`, `sdk-trace-node`) — note: `OTEL_RESOURCE_ATTRIBUTES` parsing tightened in 2.6.0 (the entire env var is dropped on any invalid entry; whitespace must be percent-encoded). Audit deployment configs.
  - `@opentelemetry/semantic-conventions` 1.34.0 → 1.40.0
  - Root tooling: `turbo` 2.9.6, `oxlint` 1.61.0, `lefthook` 2.1.6, `@changesets/cli` 2.31.0

### Patch Changes

- 31957b4: Fix oxlint warnings: hoist helpers that don't capture parent scope, replace `Array#sort()` with `Array#toSorted()` in tests, parallelise independent session evictions, route pulse-api boot error through the observability layer, and de-shadow `token` in `OrgDetailPage`.
- 31957b4: Bump `drizzle-orm` 0.45.0 → 0.45.2 (SQL injection fix in `sql.identifier()` / `sql.as()` escaping) and `astro` 6.1.5 → 6.1.9 (unsafe HTML insertion + prototype-key safeguards in error handling).
- 31957b4: In-range patch bumps: `drizzle-kit` 0.31.10, `vitest` + `@vitest/coverage-istanbul` 4.1.5, `@elysiajs/cors` 1.4.1, `@opentelemetry/api` 1.9.1, `solid-js` 1.9.12, `@solidjs/router` 0.16.1, `@tailwindcss/vite` + `tailwindcss` 4.2.4, `vite` 8.0.9, `vite-plugin-solid` 2.11.12, `@types/leaflet` 1.9.21. Adds `vite-plugin-solid` to `@osn/client` (the vitest 4.1.5 + vite 8.0.9 combo enforces stricter import-analysis on transitively imported `.tsx` files).
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
- Updated dependencies [31957b4]
  - @osn/db@0.14.1
  - @shared/crypto@0.6.7
  - @shared/observability@0.8.0
  - @shared/rate-limit@0.2.1
  - @shared/redis@0.3.0

## 3.0.0

### Major Changes

- 6387b98: Passkey-primary login (M-PK). WebAuthn (passkey or security key) is the only primary login factor. OTP and magic-link primary login, and the `enrollmentToken` JWT machinery, have been removed. Registration is WebAuthn-gated and first-credential enrollment is mandatory; `deletePasskey` refuses unconditionally if it would leave zero credentials. The "Lost your passkey?" path (recovery codes) is the single escape hatch.

  Hardenings from the security review: **S-H1** step-up gate on `/passkey/register/*` when the account already has ≥1 passkey + `security_events{passkey_register}` audit row + best-effort email notification + server-derived session token (no user-supplied body field). **S-H2** options/verifier `userVerification` alignment (`required` on both sides; rejects UP-only U2F). **S-M1** `/login/passkey/begin` returns a uniform synthetic response for unknown identifiers, closing the enumeration oracle. **S-M2** access tokens carry `aud: "osn-access"` and `verifyAccessToken` asserts it.

  **Breaking — @osn/api**

  - Removed routes: `POST /login/otp/begin`, `POST /login/otp/complete`, `POST /login/magic/begin`, `POST /login/magic/verify`.
  - Removed service methods: `beginOtp`, `completeOtpDirect`, `beginMagic`, `verifyMagicDirect`, `issueEnrollmentToken`, `verifyEnrollmentToken`.
  - `/passkey/register/{begin,complete}` now authenticates via the normal access token; enrollment tokens are gone.
  - `/passkey/register/begin` accepts an optional `step_up_token` body field or `X-Step-Up-Token` header; **required** when the account already has ≥1 passkey (S-H1).
  - `/passkey/register/complete` body no longer accepts `session_token`; the server derives it from the HttpOnly cookie (S-H1).
  - `/register/complete` response drops `enrollment_token`.
  - `/login/passkey/begin` now returns `200 { options }` in all cases (including unknown identifier) — previously 400 on unknown (S-M1).
  - Access tokens carry `aud: "osn-access"` (S-M2).
  - `AuthConfig` drops `magicLinkBaseUrl` / `magicTtl`; adds `passkeyRegisterAllowedAmr` (default `["webauthn", "otp"]`). `AuthRateLimiters` drops `otpBegin`, `otpComplete`, `magicBegin`.
  - `SecurityEventKind` union adds `"passkey_register"`.
  - `deletePasskey` refuses to drop below 1 passkey regardless of recovery-code state.
  - WebAuthn registration options use `residentKey: "preferred"` + `userVerification: "required"`; both login paths use `userVerification: "required"` to match the verifier (S-H2).

  **Breaking — @osn/client**

  - `LoginClient` now only exposes `passkeyBegin` / `passkeyComplete`. `otpBegin`, `otpComplete`, `magicBegin`, `magicVerify` removed.
  - `CompleteRegistrationResult` no longer contains `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` / `passkeyRegisterComplete` take `accessToken` instead of `enrollmentToken`.
  - `RegistrationClient.passkeyRegisterBegin` additionally accepts an optional `stepUpToken` — required when adding a passkey to an account that already has one (S-H1). The bootstrap first-passkey flow from `completeRegistration` still works without it.

  **Breaking — @osn/ui**

  - `<SignIn>` now requires a `recoveryClient: RecoveryClient` prop. The component is WebAuthn-only; it renders an informational screen when WebAuthn is unsupported, and exposes a "Lost your passkey?" link into `<RecoveryLoginForm>`.
  - `<Register>` is WebAuthn-gated. No flow path exists without WebAuthn support, and the "Skip for now" button is gone.
  - `<MagicLinkHandler>` deleted.

  **@shared/observability (minor)**

  - `AuthMethod` narrowed to `"passkey" | "recovery_code" | "refresh"`.
  - `AuthRateLimitedEndpoint` dropped `otp_begin`, `otp_complete`, `magic_begin`.

  **@pulse/app / @osn/social (patch)**

  - Pass a `recoveryClient` into `<SignIn>`; `<MagicLinkHandler>` removed from the root layout.

### Patch Changes

- Updated dependencies [6387b98]
  - @shared/observability@0.7.0
  - @shared/crypto@0.6.6

## 2.1.0

### Minor Changes

- b1d5980: M-PK: passkey-primary prerequisites — passkey management surface + discoverable-credential login.

  **Features**

  - `GET /passkeys`, `PATCH /passkeys/:id`, `DELETE /passkeys/:id` (step-up gated) — list, rename, remove credentials from Settings.
  - Discoverable-credential / conditional-UI passkey login. `POST /login/passkey/begin` accepts an empty body and returns `{ options, challengeId }`; clients round-trip the challenge ID to `/login/passkey/complete`.
  - `last_used_at` tracking on every assertion + step-up ceremony (60s coalesce).
  - WebAuthn enrolment tightened to `residentKey: "required"` + `userVerification: "required"`.
  - Hard cap of 10 passkeys per account (P-I10), enforced at both `begin` and `complete`.
  - New `SecurityEventKind` `passkey_delete` — audit row + out-of-band notification, same pattern as recovery-code generate/consume.
  - Last-passkey lockout guard: `DELETE /passkeys/:id` refuses the final credential unless recovery codes exist.
  - New `@osn/client` surface `createPasskeysClient`; `@osn/ui/auth/PasskeysView` settings panel.
  - `SignIn` opportunistically invokes `navigator.credentials.get({ mediation: "conditional" })` on mount when supported.

  **Breaking**

  - Removed the legacy unverified `POST /register` HTTP endpoint — use `/register/begin` + `/register/complete`.
  - `LoginClient.passkeyComplete` now takes `{ identifier | challengeId, assertion }` instead of positional args.
  - `AuthMethod` attribute union dropped `"password"` (OSN is passwordless).

  **DB**

  - Migration `0007_passkey_management.sql` adds `label`, `last_used_at`, `aaguid`, `backup_eligible`, `backup_state`, `updated_at` columns to `passkeys` (all nullable).

  **Observability**

  - New span names `auth.passkey.{list,rename,delete}`.
  - New counter `osn.auth.passkey.operations{action, result}`.
  - New histogram `osn.auth.passkey.duration{action, result}`.
  - New counter `osn.auth.passkey.login_discoverable{result}`.
  - `SecurityInvalidationTrigger` extended with `passkey_delete`.
  - Log redaction deny-list adds `attestation`, `passkeyLabel`/`passkey_label`.

### Patch Changes

- Updated dependencies [b1d5980]
  - @osn/db@0.14.0
  - @shared/observability@0.6.1
  - @shared/crypto@0.6.5

## 2.0.0

### Major Changes

- c04163d: Remove legacy OAuth authorization-code / PKCE flow.

  The first-party `/login/*` endpoints (Session + PublicProfile returned inline)
  are now the only sign-in surface. The following are gone:

  - Server routes `GET /authorize`, `POST /token` `grant_type=authorization_code`,
    `POST /passkey/login/{begin,complete}`, `POST /otp/{begin,complete}`,
    `POST /magic/begin`, `GET /magic/verify`
  - Service methods `exchangeCode`, `issueCode`, `completePasskeyLogin`,
    `completeOtp`, `verifyMagic`, `validateRedirectUri`; `AuthConfig.allowedRedirectUris`
  - Client API `OsnAuthService.startLogin` / `handleCallback`, module `@osn/client/pkce`,
    errors `AuthorizationError`, `TokenExchangeError`, `StateMismatchError`;
    `OsnAuthConfig.clientId`
  - Solid context methods `login` / `handleCallback`
  - `<CallbackHandler />` components in `@pulse/app` and `@osn/social`
  - Helper files `osn/api/src/lib/html.ts`, `osn/api/src/lib/crypto.ts`
  - Rate-limiter slot `magicVerify` and `AuthRateLimitedEndpoint` variant `magic_verify`

  OIDC discovery now reports `grant_types_supported: ["refresh_token"]` only.
  Magic-link emails point at `/login/magic/verify` (consumed client-side by
  `MagicLinkHandler`).

### Patch Changes

- Updated dependencies [c04163d]
  - @shared/observability@0.6.0
  - @shared/crypto@0.6.4

## 1.8.0

### Minor Changes

- 811eda4: feat(auth): out-of-band security-event audit + notification for recovery-code regeneration (M-PK1b)

  - Adds a `security_events` table and inserts an audit row inside the same transaction that regenerates recovery codes. The row captures the UA label + peppered IP hash of the request that triggered it.
  - Sends a best-effort notification email ("Your OSN recovery codes were regenerated") on success. Email failure is logged and reported via metrics but never rolls back the primary action — the audit row is the signal.
  - Exposes `GET /account/security-events` and `POST /account/security-events/:id/ack` (Bearer-authenticated, rate-limited). The list surface only returns unacknowledged rows; ack is idempotent and scoped to the owning account.
  - Adds a `SecurityEventsBanner` component (`@osn/ui/auth`) plus `createSecurityEventsClient` (`@osn/client`) so the Settings surface can render "was this you?" prompts that keep rendering until dismissed — regardless of whether the confirmation email was delivered.
  - New OTel counters + histogram on `osn.auth.security_event.*` (recorded, notified, acknowledged, notify.duration), all with bounded string-literal attributes.
  - Redaction deny-list now covers `securityEventId` / `security_event_id`.

  Unblocks the Phase 5 passkey-primary migration: a stolen access token + inbox hijack can no longer silently burn the account's recovery codes.

### Patch Changes

- Updated dependencies [811eda4]
  - @osn/db@0.13.0
  - @shared/observability@0.5.2
  - @shared/crypto@0.6.3

## 1.7.1

### Patch Changes

- 58e3e12: Cluster-safe rotated-session store for C2 reuse detection (S-H1 session / P-W1 session). Extracted `RotatedSessionStore` interface with in-memory + Redis-backed impls in `osn/api/src/lib/rotated-session-store.ts`, wired from `osn/api/src/index.ts`. Shipping with `{action, result, backend}`-dimensioned counter + duration histogram (`osn.auth.session.rotated_store.*`) and `RotatedStoreAction`/`RotatedStoreResult`/`RotatedStoreBackend` attribute unions in `@shared/observability`. Fail-open on Redis error so an outage cannot manufacture false-positive family revocations.
- Updated dependencies [58e3e12]
  - @shared/observability@0.5.1
  - @shared/crypto@0.6.2

## 1.7.0

### Minor Changes

- dc8c384: Auth phase 5a: step-up (sudo) ceremonies, session introspection/revocation, and email change.

  **New features**

  - **Step-up (sudo) tokens** — short-lived (5 min) ES256 JWTs with `aud: "osn-step-up"` minted by a passkey or OTP ceremony, required by sensitive endpoints. Replay-guarded via `jti` tracking. Routes: `POST /step-up/{passkey,otp}/{begin,complete}`.
  - **Session introspection + revocation** — `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`. Each session now carries a coarse UA label (e.g. "Firefox on macOS"), an HMAC-peppered IP hash, and a `last_used_at` timestamp. Revocation handles are the first 16 hex chars of the session SHA-256.
  - **Email change** — `POST /account/email/{begin,complete}`, step-up-gated. Hard cap of 2 changes per trailing 7 days. Atomic with session invalidation so a partial failure can never leave a stale-email session alive. Audit rows persist in the new `email_changes` table.

  **Breaking changes**

  - `/recovery/generate` now requires a step-up token (`X-Step-Up-Token` header or `step_up_token` body param) with `webauthn` or `otp` amr. The old "1 per day" rate limit is replaced by a per-hour throttle; the step-up gate is the real defence.
  - `Session` no longer carries `refreshToken` — the refresh token is HttpOnly-cookie-only after C3. `AccountSession` drops `refreshToken` and adds `hasSession: boolean`. Any stored client session state will fail schema validation and be silently cleared (users will re-login).
  - `POST /logout` no longer accepts `refresh_token` in the body — cookie-only.

  **Observability**

  - New metrics: `osn.auth.step_up.{issued,verified}`, `osn.auth.session.operations`, `osn.auth.account.email_change.{attempts,duration}`.
  - New `SecurityInvalidationTrigger` enum members: `session_revoke`, `session_revoke_all`.
  - New redaction deny-list entries: `stepUpToken`, `ipHash`, `uaLabel` (both spellings).

  Migration `0005_sessions_metadata_and_email_change.sql` adds `sessions.ua_label`, `sessions.ip_hash`, `sessions.last_used_at`, and the new `email_changes` table.

### Patch Changes

- Updated dependencies [dc8c384]
  - @osn/db@0.12.0
  - @shared/observability@0.5.0
  - @shared/crypto@0.6.1

## 1.6.0

### Minor Changes

- 9459f5e: feat(auth): recovery codes (Copenhagen Book M2) + short-lived access tokens

  **Recovery codes (M2)**

  - 10 × 64-bit single-use codes per generation (`xxxx-xxxx-xxxx-xxxx`), SHA-256 hashed at rest in the new `recovery_codes` table.
  - `POST /recovery/generate` (Bearer-auth, 3/hr/IP) returns the raw codes exactly once; regenerating atomically invalidates the prior set.
  - `POST /login/recovery/complete` (5/hr/IP) consumes a code, revokes every session on the account, and establishes a fresh session + cookie.
  - `@shared/crypto` exports `generateRecoveryCodes`, `hashRecoveryCode`, `verifyRecoveryCode`.
  - `@osn/client` exposes `createRecoveryClient`; `@osn/ui` ships `RecoveryCodesView` and `RecoveryLoginForm`.
  - Observability: `osn.auth.recovery.codes_generated`, `osn.auth.recovery.code_consumed{result}`, `osn.auth.recovery.duration`; spans `auth.recovery.{generate,consume}`; redaction deny-list additions for recovery fields.

  **Short-lived access tokens**

  - Default access-token TTL cut from 3600s to 300s (breaking for third-party consumers that cached past `expires_in`).
  - New `OsnAuthService.authFetch(input, init)` (also exposed via the SolidJS `useAuth()` context) silent-refreshes on 401 via the HttpOnly session cookie and retries once; surfaces `AuthExpiredError` when refresh fails.

  **Migration**

  - New Drizzle migration `osn/db/drizzle/0004_add_recovery_codes.sql`.
  - `AuthRateLimiters` gains `recoveryGenerate` and `recoveryComplete` (Redis bundle auto-populated).

  Mitigates prior backlog items: `S-M20` (refresh tokens in localStorage — now paired with a 5-min access-token ceiling) and unblocks M-PK (passkey-primary migration).

### Patch Changes

- Updated dependencies [9459f5e]
  - @osn/db@0.11.0
  - @shared/crypto@0.6.0
  - @shared/observability@0.4.0

## 1.5.0

### Minor Changes

- 2d5cce9: HttpOnly cookie sessions (C3), Origin guard (M1), hash magic/OTP tokens (H2/H3), extract shared auth derive (S-M2)

### Patch Changes

- Updated dependencies [2d5cce9]
  - @shared/observability@0.3.3
  - @shared/crypto@0.5.3

## 1.4.0

### Minor Changes

- 2a7eb82: feat(auth): refresh token rotation (C2), session invalidation on security events (H1), profile endpoints migrated to access token auth (S-H1)

  - **C2**: Refresh token rotation on every `/token` refresh grant. New `familyId` column on `sessions` table groups all tokens in a chain. Replaying a rotated-out token revokes the entire family.
  - **H1**: `invalidateOtherAccountSessions(accountId, keepSessionHash)` revokes all sessions except the caller's on passkey registration.
  - **S-H1**: `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`, `/profiles/:id/default` authenticate via `Authorization: Bearer <access_token>` instead of `refresh_token` in body.
  - Observability: 4 new session metrics, 3 new spans, `familyId` added to redaction deny-list.

### Patch Changes

- Updated dependencies [2a7eb82]
  - @osn/db@0.10.0
  - @shared/observability@0.3.2
  - @shared/crypto@0.5.2

## 1.3.0

### Minor Changes

- ac6a86c: feat(auth): server-side sessions with revocation (Copenhagen Book C1)

  Replace stateless JWT refresh tokens with opaque server-side session tokens.
  Session tokens use 160-bit entropy, stored as SHA-256 hashes in the new `sessions` table.
  Sliding-window expiry, single-session and account-wide revocation, `POST /logout` endpoint.
  Removes deprecated `User`/`NewUser` type aliases and legacy client session migration.

### Patch Changes

- Updated dependencies [ac6a86c]
  - @osn/db@0.9.0
  - @shared/crypto@0.5.1

## 1.2.0

### Minor Changes

- 0edef32: Switch OSN access token signing from HS256 to ES256 and expose a JWKS endpoint.

  - `@shared/crypto`: add `thumbprintKid(publicKey)` helper (RFC 7638 SHA-256 thumbprint)
  - `@shared/observability`: add `JwksCacheResult` metric attribute type
  - `@osn/api`: replace `AuthConfig.jwtSecret` with `jwtPrivateKey`, `jwtPublicKey`, `jwtKid`, `jwtPublicKeyJwk`; add `GET /.well-known/jwks.json`; update OIDC discovery with `jwks_uri`; ephemeral key pair in local dev when env vars are unset
  - `@pulse/api`: replace symmetric JWT verification with JWKS-backed ES256 verification; add in-process JWKS key cache with 5-minute TTL and rotation-aware refresh; remove `OSN_JWT_SECRET` dependency

### Patch Changes

- Updated dependencies [0edef32]
  - @shared/crypto@0.5.0
  - @shared/observability@0.3.1

## 1.1.1

### Patch Changes

- Updated dependencies [1f14c6a]
  - @shared/crypto@0.4.1

## 1.1.0

### Minor Changes

- 177eeea: Merge `@osn/core` into `@osn/api` and move `@osn/crypto` to `@shared/crypto`.

  - `@osn/api` now owns all auth, graph, org, profile, and recommendations routes and services directly — no longer delegates to `@osn/core`
  - `@shared/crypto` is the new home for ARC token crypto (was `@osn/crypto`); available to all workspace packages
  - ARC audience claim updated from `"osn-core"` to `"osn-api"` for consistency with the merged service identity
  - `@pulse/api` updated to import from `@shared/crypto` and target `aud: "osn-api"` on outbound ARC tokens

### Patch Changes

- Updated dependencies [177eeea]
  - @shared/crypto@0.4.0

## 1.0.3

### Patch Changes

- Updated dependencies [fe55da8]
  - @osn/db@0.8.0
  - @osn/core@0.18.0

## 1.0.2

### Patch Changes

- Updated dependencies [f594a46]
  - @osn/core@0.17.2

## 1.0.1

### Patch Changes

- Updated dependencies [1d9be5a]
  - @osn/core@0.17.1

## 1.0.0

### Major Changes

- 4197434: Rename package from `@osn/app` to `@osn/api` and move directory from `osn/app/` to `osn/api/`. The server binary is now `@osn/api` — a clearer name that signals this is an API server, not a frontend app.

## 0.3.12

### Patch Changes

- e2e010e: Add `@osn/social` app — identity and social graph management UI. Add
  `recommendations` service and route to `@osn/core`. Add `graph` and
  `organisations` client modules with Solid `GraphProvider` and `OrgProvider`.
  Fix dropdown menu not opening by wrapping `DropdownMenuLabel` in
  `DropdownMenuGroup` (required by Kobalte).
- Updated dependencies [e2e010e]
  - @osn/core@0.17.0

## 0.3.11

### Patch Changes

- Updated dependencies [d691034]
  - @osn/core@0.16.4

## 0.3.10

### Patch Changes

- 09a2a60: Add four-tier environment model (local/dev/staging/production). Local env gets debug log level and OTP codes printed to terminal; all other environments default to info. Disable SO_REUSEPORT on all servers so stale processes cause EADDRINUSE errors instead of silently intercepting requests. Add email validation message to registration form. Remove Vite devtools plugin.
- Updated dependencies [09a2a60]
  - @shared/observability@0.3.0
  - @osn/core@0.16.3

## 0.3.9

### Patch Changes

- Updated dependencies [42589e2]
  - @shared/observability@0.2.10
  - @osn/core@0.16.2

## 0.3.8

### Patch Changes

- Updated dependencies [a723923]
  - @osn/core@0.16.1
  - @osn/db@0.7.2
  - @shared/observability@0.2.9

## 0.3.7

### Patch Changes

- Updated dependencies [8137051]
  - @osn/core@0.16.0
  - @shared/observability@0.2.8

## 0.3.6

### Patch Changes

- Updated dependencies [33e6513]
  - @osn/core@0.15.0
  - @shared/observability@0.2.7

## 0.3.5

### Patch Changes

- Updated dependencies [5520d90]
  - @osn/db@0.7.1
  - @osn/core@0.14.1

## 0.3.4

### Patch Changes

- Updated dependencies [f5c1780]
  - @osn/db@0.7.0
  - @osn/core@0.14.0
  - @shared/observability@0.2.6

## 0.3.3

### Patch Changes

- e2ef57b: Add organisation support with membership and role management
- Updated dependencies [e2ef57b]
  - @osn/db@0.6.0
  - @osn/core@0.13.0
  - @shared/observability@0.2.5

## 0.3.2

### Patch Changes

- 8732b5a: Audit and update dependencies across all workspaces: align version drift (typescript, vitest, solid-js), bump minor versions (drizzle-orm, drizzle-kit, @effect/vitest, @effect/opentelemetry, OTel exporters, @solidjs/router), and apply patches (@astrojs/solid-js, @astrojs/check).
- Updated dependencies [8732b5a]
  - @osn/core@0.12.1
  - @osn/db@0.5.3
  - @shared/observability@0.2.4
  - @shared/redis@0.2.2

## 0.3.1

### Patch Changes

- b48d68e: Add ARC token verification middleware and internal graph routes for S2S authentication on `/graph/internal/*` endpoints.
- Updated dependencies [b48d68e]
  - @osn/core@0.12.0

## 0.3.0

### Minor Changes

- 19c39ba: feat(redis): wire up Redis-backed rate limiters (Phase 3)

  - Add `createRedisAuthRateLimiters()` and `createRedisGraphRateLimiter()` factories
    in `@osn/core` that build Redis-backed rate limiters from a `RedisClient`
  - Add `createClientFromUrl()` to `@shared/redis` so consumers don't need ioredis
    as a direct dependency
  - Wire env-driven backend selection in `@osn/app`: `REDIS_URL` set → Redis with
    startup health check; unset → in-memory fallback; graceful degradation on
    connection failure
  - All 12 rate limiters (11 auth + 1 graph) now use Redis when available
  - Resolves S-M2 (rate limiter resets on restart) for production deployments

### Patch Changes

- Updated dependencies [19c39ba]
  - @osn/core@0.11.0
  - @shared/redis@0.2.1

## 0.2.4

### Patch Changes

- Updated dependencies [77ce7ad]
  - @osn/core@0.10.0

## 0.2.3

### Patch Changes

- Updated dependencies [e8b4f93]
  - @osn/core@0.9.0
  - @osn/db@0.5.2
  - @shared/observability@0.2.3

## 0.2.2

### Patch Changes

- Updated dependencies [f87d7d2]
  - @osn/core@0.8.0
  - @shared/observability@0.2.2

## 0.2.1

### Patch Changes

- 1cc3aa5: Migrate dev-mode `console.log` of registration OTP, login OTP, and magic-link
  URL in `osn/core/src/services/auth.ts` to `Effect.logDebug` (S-H21). The values
  stay interpolated into the message string so the redacting logger doesn't scrub
  them — the whole point of these dev branches is to expose the code/URL to the
  developer.

  `createAuthRoutes` and `createGraphRoutes` now accept an optional third
  `loggerLayer: Layer.Layer<never>` parameter (defaulting to `Layer.empty`) which
  is provided to the per-request Effect runtime alongside `dbLayer`. Without this
  wiring `Effect.logDebug` calls inside auth services would be silently dropped
  by Effect's default `Info` minimum log level, breaking local dev UX after the
  migration. `osn/app/src/index.ts` now threads its `observabilityLayer` through
  to both route factories (S-L1). The parameter is optional and backwards
  compatible for any downstream caller.

  Trim the redaction deny-list in `@shared/observability` to only the keys that
  correspond to real object properties in the codebase today: `authorization`,
  the OAuth token fields (`accessToken`/`refreshToken`/`idToken`/`enrollmentToken`

  - snake_case), the WebAuthn `assertion` body, ARC `privateKey`, and the user
    PII fields `email` / `handle` / `displayName`. Removes ~30 speculative entries
    (Signal/E2E keys, password fields, address/SSN/etc.) that were never reached.
    `enrollmentToken` is added because it is a real bearer credential returned by
    `/register/complete` and sent back as `Authorization: Bearer <token>` for
    passkey enrollment (S-M1). Adds a documented criteria block at the top of
    `redact.ts` explaining when to add or remove keys, a lock-step assertion in
    `redact.test.ts` pinning the exact set, a positive assertion for the enrollment
    token, and a behavioural regression anchor (T-S1) that proves previously-
    scrubbed keys now pass through unchanged. Dev-log branch coverage is locked
    with three new `it.effect` tests using a `Logger.replace` capture sink (T-U1).

- Updated dependencies [1cc3aa5]
  - @osn/core@0.7.0
  - @shared/observability@0.2.1

## 0.2.0

### Minor Changes

- cab97ca: Wire `@shared/observability` into OSN Core (auth + social graph) and the
  OSN auth server (`@osn/app`).

  **`@osn/core`**:

  - New `src/metrics.ts` defines typed OSN Core counters and histograms:
    - `osn.auth.register.attempts{step,result}` + `.duration{step}`
    - `osn.auth.login.attempts{method,result}` + `.duration{method}`
    - `osn.auth.token.refresh{result}`
    - `osn.auth.handle.check{result}` (`available` / `taken` / `invalid`)
    - `osn.auth.otp.sent{purpose}` (`registration` / `login`)
    - `osn.auth.magic_link.sent{result}`
    - `osn.graph.connection.operations{action,result}`
    - `osn.graph.block.operations{action,result}`
  - Curried pipe-friendly helpers (`withAuthRegister("begin")`,
    `withAuthLogin("passkey")`, `withGraphConnectionOp("request")`, …)
    attach a span AND record the outcome in a single `.pipe()` call.
    Duration histograms use the standard latency buckets from
    `@shared/observability`.
  - `classifyError()` maps any caught Effect error into the bounded
    `Result` union so metric cardinality stays compile-time enforced.
  - Auth service: `beginRegistration`, `completeRegistration`, `checkHandle`,
    `refreshTokens`, `beginPasskeyLogin`, `completePasskeyLogin`,
    `completePasskeyLoginDirect`, `beginOtp`, `completeOtp`,
    `completeOtpDirect`, `beginMagic`, `verifyMagic`, `verifyMagicDirect`
    are now instrumented with spans + metrics. OTP-sent and magic-link-sent
    counters fire on the happy path inside the relevant flows.
  - Graph service: `sendConnectionRequest`, `acceptConnection`,
    `rejectConnection`, `removeConnection`, `blockUser`, `unblockUser` are
    instrumented with spans + typed graph counters.

  **`@osn/app`**:

  - Entry point now calls `initObservability({ serviceName: "osn-app" })`
    and wires up `observabilityPlugin` + `healthRoutes` (replacing the
    inline `/health` handler). Updated the existing test to match the new
    shared health-route shape (`{ status: "ok", service: "osn-app" }`).
  - Structured boot log via `Effect.logInfo` instead of `console.log`.

  **Under the hood**:

  - `@shared/observability/src/tracing/layer.ts` now imports `NodeSdk`
    directly from the `@effect/opentelemetry/NodeSdk` subpath (not the
    root barrel) so that vitest doesn't eagerly try to resolve the
    optional `@opentelemetry/sdk-trace-web` peer dep the barrel's
    `WebSdk.js` module pulls in.

  **Out of scope for this PR** (deliberately): migration of stray
  `console.*` calls in auth flows (tracked as S-L8), WebSocket
  instrumentation, dashboards and alerts, actual Grafana Cloud endpoint
  provisioning.

### Patch Changes

- Updated dependencies [cab97ca]
- Updated dependencies [cab97ca]
  - @osn/core@0.6.0
  - @shared/observability@0.2.0

## 0.1.7

### Patch Changes

- 97f35e5: Restructure the monorepo by domain. Top-level directories are now `osn/`, `pulse/`, and `shared/`, with matching workspace prefixes (`@osn/*`, `@pulse/*`, `@shared/*`). Key renames:

  - `@osn/osn` (apps/osn) → `@osn/app` (osn/app)
  - `@osn/pulse` (apps/pulse) → `@pulse/app` (pulse/app)
  - `@osn/api` (packages/api) → `@pulse/api` (pulse/api) — this package has always been Pulse's events server, the `@osn/` prefix was misleading
  - `@utils/db` → `@shared/db-utils`
  - `@osn/typescript-config` → `@shared/typescript-config`

  `@osn/core` remains unchanged as the OSN identity library consumed by `@osn/app`. The prefix rule going forward: `@osn/*` = identity stack, `@pulse/*` = events stack, `@shared/*` = cross-cutting utilities.

- Updated dependencies [97f35e5]
- Updated dependencies [97f35e5]
  - @osn/core@0.5.0
  - @osn/db@0.5.1

## 0.1.6

### Patch Changes

- Updated dependencies [cf57969]
  - @osn/core@0.4.0

## 0.1.5

### Patch Changes

- 3a0196b: Update CLAUDE.md with complete ARC token usage guidance: when to use ARC vs. direct package import, calling/receiving service patterns with code examples, and service registration steps.
- Updated dependencies [3a0196b]
  - @osn/core@0.3.2

## 0.1.4

### Patch Changes

- Updated dependencies [45248b2]
- Updated dependencies [45248b2]
  - @osn/db@0.5.0
  - @osn/core@0.3.1

## 0.1.3

### Patch Changes

- Updated dependencies [623ad9f]
  - @osn/db@0.4.0
  - @osn/core@0.3.0

## 0.1.2

### Patch Changes

- Updated dependencies [9caa8c7]
  - @osn/db@0.3.0
  - @osn/core@0.2.0

## 0.1.1

### Patch Changes

- Updated dependencies [05a9022]
  - @osn/db@0.2.3
  - @osn/core@0.1.1

## 0.1.0

### Minor Changes

- 75f801b: Implement OSN Core auth system.

  - `@osn/core`: new auth implementation — passkey (WebAuthn via @simplewebauthn/server), OTP, and magic-link sign-in flows; PKCE authorization endpoint; JWT-based token issuance and refresh; OIDC discovery; Elysia route factory; sign-in HTML page with three-tab UI; 25 service tests + route integration tests
  - `@osn/osn`: new Bun/Elysia auth server entrypoint at port 4000; imports `@osn/core` routes; dev JWT secret fallback
  - `@osn/db`: schema updated with `users` and `passkeys` tables; migration generated
  - `@osn/client`: `getSession()` now checks `expiresAt` and clears expired sessions; `handleCallback` exposed from `AuthProvider` context
  - `@osn/pulse`: `CallbackHandler` handles OAuth redirect on page load; fix events resource to load without waiting for auth; fix location autocomplete re-triggering search after selection
  - `@osn/api`: HTTP-level route tests for category filter and invalid startTime/endTime

### Patch Changes

- Updated dependencies [75f801b]
  - @osn/core@0.1.0
  - @osn/db@0.2.2
