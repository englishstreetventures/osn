# OSN Project TODO

Progress tracking and deferred decisions. Completed items archived in `[[changelog/]]`. For full spec see README.md. For code patterns see CLAUDE.md. For detailed system docs see [[index]].

## Up Next

- [x] Multi-account P3 — Profile CRUD: `createProfileService()` (create, delete, set default), `/profiles` routes, `maxProfiles` enforcement (S-L1), cascade-delete profile data, observability (counter + histogram + spans)
- [x] Multi-account P4 — Client SDK: multi-session storage (`@osn/client:account_session`), `listProfiles()`, `switchProfile()`, `createProfile()`, `deleteProfile()`, `getActiveProfile()` methods on `OsnAuthService`, SolidJS `AuthContext` integration, legacy session migration, schema validation
- [x] Multi-account P5 — Profile UI: profile switcher component in `@osn/ui`, profile creation form, onboarding for additional profiles
- [x] Multi-account P6 — Privacy audit: verify `accountId` never leaks in API responses / tokens / logs, rate-limit per-profile (not per-account), pen-test correlation attacks between profiles
- [ ] Provision Grafana Cloud free tier + wire `OTEL_EXPORTER_OTLP_ENDPOINT` + headers into deploy env — see [[observability-setup]]
- [ ] Build first observability dashboards (HTTP RED, auth funnel, ARC verification, events CRUD) — see [[observability/overview]]
- [ ] Zap route-level tests + zapBridge tests (T-R1, T-M1 from review)
- [ ] Zap rate limiting on write endpoints (S-M1) — see [[rate-limiting]]
- [ ] Recommendations SQL aggregation + caching (P-W6/P-W7) — next step after the in-JS fan-out cap shipped in this PR — see [[social-graph]]
- [ ] Factor shared `authGet/Post/Patch/Delete` helpers in `@osn/client` (P-I1)
- [x] Auth Improvements Phase 1: Server-side sessions + refresh token rotation + session invalidation (C1/C2/H1)
- [x] Auth Improvements Phase 4: Recovery codes (M2) + short access-token TTL (5 min) with client silent-refresh on 401 — see [[recovery-codes]]
- [x] Auth Improvements Phase 5a: Step-up (sudo) tokens (M-PK1), session introspection/revocation UI, email change flow — see [[step-up]], [[sessions]]
- [ ] Auth Improvements Phase 5b: ~~Redis-backed rotated-session store~~ (shipped — see [[sessions]]), ~~PKCE cleanup~~ (shipped — deleted `/authorize`, `authorization_code` grant, `pkceStore`, client `pkce.ts` + `startLogin`/`handleCallback`; magic link now routes through frontend origin via POST body, S-M1 body fallback on `/token` removed), ~~passkey management surface~~ (shipped — see [[identity-model]]: list/rename/delete, discoverable-credential login, last-passkey lockout guard), passkey-primary login (demote OTP/magic-link to recovery-only)

---

## Pulse (`pulse/app` + `pulse/api` + `pulse/db`)

- [ ] "What's on today" default view
- [ ] Prompt for max event duration when creating events without an endTime
- [ ] Event discovery (location, category, datetime, friends, interests)
- [ ] Recurring events (series + instances)
- [ ] Event group chats (via Zap once M2 lands — placeholder shipped)
- [ ] Organizer tools (moderation, blacklists)
- [ ] Venue pages
- [ ] Real SMS/email comms providers — `sendBlast` is stubbed (writes to `event_comms`); plug in actual delivery
- [ ] Tighten Tauri CSP to allowlist `*.tile.openstreetmap.org` for Leaflet tile loads (rolls into S-L3)
- [ ] Drizzle: extract shared `createSchemaSql()` helper so adding a column is a one-file change (currently hand-rolled in 3 places)
- [ ] Verified-organisation tier (Phase 2): org accounts can run events over `MAX_EVENT_GUESTS` (1000) via per-event support flow

---

## OSN Core (`osn/api`)

- [x] Multi-account profile CRUD (P3) — create/delete/set-default profiles, maxProfiles enforcement, cascade delete, observability
- [x] Multi-account client SDK (P4) — multi-session storage, profile switching, schema validation, security hardening
- [x] Multi-account UI (P5) — profile switcher component, create form, onboarding
- [x] Multi-account privacy audit (P6) — accountId leak verification, per-profile rate limits
- [ ] Per-app vs global blocking logic (deferred — global blocking across all OSN apps for now)
- [ ] Interest profile selection (onboarding)
- [ ] Third-party app authorization flow
- [x] Organisation frontend — standalone `@osn/social` app delivered (2026-04-16); Tauri wrapping deferred
- [x] Merge `@osn/core` into `@osn/api`, move `@osn/crypto` → `@shared/crypto`; ARC audience updated `"osn-core"` → `"osn-api"`
- [x] Step-up (sudo) tokens (M-PK1) — ES256 JWTs with `aud: "osn-step-up"`, passkey/OTP ceremonies, required on `/recovery/generate` + `/account/email/complete` — see [[step-up]]
- [x] Session introspection + per-device revocation — `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`, coarse UA labels, HMAC-peppered IP hash, `last_used_at` — see [[sessions]]
- [x] Email-change ceremony — step-up gated, OTP to new address, transactional other-session revoke, 2-per-7-days cap, `email_changes` audit table
- [x] Session + `AccountSession` types drop `refreshToken` — cookie-only first-party; `AccountSession.hasSession` replaces stored refresh token. `/logout` body no longer accepts `refresh_token`.
- [ ] Recommendations SQL aggregation + compound indexes (P-W7) — push FOF counting into DB, add `connections(status, requester_id)` + `connections(status, addressee_id)` — see [[social-graph]]
- [ ] Unified `handles` reservation table (user + org handles share namespace; currently enforced at service layer — see Deferred Decisions)

---

## Zap (`zap/app` + `zap/api` + `zap/db`)

OSN's messaging app. Stack matches Pulse (Bun, Tauri+Solid, Elysia+Eden, Drizzle+SQLite, Effect.ts) unless a real reason emerges to diverge. Signal Protocol lives in `@osn/crypto`, not `zap/`.

### M0 — Scaffold (remaining)

- [ ] `bunx create-tauri-app` for `@zap/app` (iOS target enabled, Solid template)
- [ ] `@zap/app` consumes `@osn/client` + `@osn/ui/auth` for sign-in (re-uses `<SignIn>` / `<Register>` from Pulse)
- [ ] Register `zap-app` and `zap-api` in `service_accounts` + `service_account_keys` (ARC issuer rows + initial key)

### M1 — 1:1 DMs (E2E)

- [ ] Signal Protocol primitives in `@osn/crypto/signal` (X3DH handshake, double ratchet)
- [ ] WebSocket transport for live message delivery (`@zap/api`)
- [ ] Push receipt + read receipt model (defer push notifications to M4)
- [ ] `@zap/app` Socials view: chat list + message thread UI
- [ ] Resolve recipients via `@osn/client` (handle → user lookup) + ARC-gated `/graph/internal/connections` to filter out blocked users
- [ ] Test coverage: handshake, ratchet, message ordering, blocked-user enforcement
- [ ] Disappearing messages flag at chat level + per-message TTL sweep

### M2 — Group chats

- [ ] Group session establishment (sender keys or MLS — pick one and document)
- [ ] `@zap/db` schema: `chat_role` (admin/member), `chat_invites`
- [ ] Add/remove members, role transitions, invite links
- [ ] Group-level disappearing-message defaults
- [ ] Show linked event overview inside the chat settings sheet (read from `@pulse/api` via Eden or ARC-gated S2S)
- [ ] Test coverage: group rekeying on member removal, race conditions on simultaneous joins

### M3 — Organisation chats (the differentiator)

- [ ] Verification flow (manual review for now; document the criteria)
- [ ] `org_chats` and `org_agents` schemas in `@zap/db` — assignment, queue, status (open/pending/resolved), SLA timestamps
- [ ] Organisation-side dashboard (separate `@zap/app` view, role-gated): inbox, agent assignment, transcript export, analytics
- [ ] Embeddable web widget — small standalone bundle (Vite + Solid) shipped from `@zap/api` static
- [ ] E-commerce checkout integration: capture OSN handle alongside email at checkout
- [ ] Public REST API for orgs to ingest support context from third-party systems

### M4 — Locality / government channels

- [ ] Locality opt-in flow in `@zap/app` (permanent home + temporary travel subscriptions with expiry)
- [ ] `localities` and `locality_subscriptions` schemas in `@zap/db`; `locality_org` join to organisations
- [ ] Push channel for verified locality/government broadcasts (one-way; users can ask follow-ups via org channel)
- [ ] AI-assisted query endpoint scoped to a locality — defer model choice
- [ ] Privacy: locality stored on device + minimal server-side join; user-resettable
- [ ] Test coverage: travel subscription expiry, broadcast fan-out, query authority filtering

### M5 — Polish + AI view + native

- [ ] Themes (token-driven, share `@osn/ui` design tokens)
- [ ] Stickers + GIFs (third-party provider TBD; needs CSP review)
- [ ] Polls (per-chat, with privacy mode)
- [ ] Easter-egg mini-games (scoped, opt-in)
- [ ] AI view: dedicated tab for model conversations, quarantined from Socials inbox
- [ ] Push notifications (APNs first, FCM later)
- [ ] Backup options: encrypted cloud / self-hosted / local-only
- [ ] Device transfer flow (key migration, backup restore)

### Cross-cutting / open questions

- [ ] Signal vs MLS for group chats — decide before M2
- [ ] Storage backend at scale: SQLite → Postgres / Supabase when message volume forces it
- [ ] Message media (images, video, voice notes) — needs E2E-friendly blob storage. Defer to post-M2
- [ ] Spam / abuse model for organisation handles — verification gate is M3 but needs ongoing review tooling

---

## Landing (`osn/landing`)

- [ ] Design and build landing page content
- [ ] Deploy (Vercel/Cloudflare)

---

## Platform

### Pulse events API (`pulse/api`)

- [ ] Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (currently N individual writes)
- [ ] Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *`
- [x] S2S graph access: graphBridge migrated to ARC-token HTTP calls against `/graph/internal/*` (direct @osn/core import removed)
- [ ] OSN/messaging domain modules
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers

### Database (`osn/db`, `pulse/db`)

- [x] OSN Core: session schema — server-side sessions with SHA-256 hashed opaque tokens (Copenhagen Book C1)
- [ ] Pulse: event series schema
- [ ] Add indexes on `status` and `category` columns in pulse-db events schema

### Crypto (`osn/crypto`)

- [x] JWKS endpoint + ES256 access tokens — `GET /.well-known/jwks.json` live in `@osn/api`; `@pulse/api` verifies via JWKS cache — see [[arc-tokens]]
- [ ] JWKS URL fallback in `resolvePublicKey` for third-party apps (currently first-party only via `service_account_keys`)

### UI Components (`osn/ui`)

- [ ] Design system / tokens
- [ ] Button, Input, Card basics
- [ ] Chat interface (shared between Pulse and Messaging)
- [ ] Event card component
- [ ] Calendar component

### Redis Migration Phase 4 — see [[redis]]

Phases 1–3 complete (abstraction layer, `@shared/redis` package, wire-up). Details in [[changelog/completed-features]].

**Phase 4 — Auth state migration (S-M8)**
- [ ] `otpStore` → Redis with TTL (resolves S-M8 partial, P-W4 partial)
- [ ] `magicStore` → Redis with TTL
- [x] ~~`pkceStore` → Redis with TTL + size bound (resolves S-L23)~~ — **Obsolete**: `pkceStore` deleted entirely with the PKCE flow removal (Phase 5b)
- [ ] `pendingRegistrations` → Redis with TTL

**Observability (Redis)**
- [ ] Logs: `Effect.logError` on Redis connection failures + command errors; `Effect.logWarning` on fallback-to-in-memory transitions; add `redisPassword` / `redis_password` to redaction deny-list
- [ ] Traces: `Effect.withSpan("redis.rate_limit.check")`, `Effect.withSpan("redis.connection.health")`, `Effect.withSpan("redis.auth_state.get|set")` (Phase 4)
- [ ] Metrics: `redis.command.duration` histogram, `redis.command.errors` counter, `redis.connection.state` gauge; bounded attrs
- [ ] Capacity: `redis.memory.bytes` gauge (from `INFO memory`; alert at 80% of `maxmemory`), `redis.store.keys` gauge per namespace

---

## Security Backlog

Open findings only. Completed fixes archived in [[changelog/security-fixes]].

### High

- [x] S-H1 (client) — Refresh token sent in JSON body to `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`. **Fixed** — all profile endpoints now authenticate via `Authorization: Bearer <access_token>` header; refresh token no longer sent in request body — see [[identity-model]]
- [x] S-H21 — Dev-mode `console.log` of OTP codes + recipient email in `osn/core/src/services/auth.ts`. **Fixed** — already uses `Effect.logDebug` (not `console.log`); guard tightened to `OSN_ENV` in log-level-debug PR.
- [x] S-H100 — Revoked ARC keys valid for 5 min after revocation (in-process cache bypass). **Fixed** — `evictPublicKeyCacheEntry(kid)` called immediately on revoke; `publicKeyCache` stores `allowedScopes` for cache-hit scope validation — see [[arc-tokens]]
- [x] S-H101 — `INTERNAL_SERVICE_SECRET` comparison not timing-safe. **Fixed** — `crypto.timingSafeEqual` in both `/register-service` and `/service-keys/:keyId` — see [[arc-tokens]]

### Medium

- [ ] S-M1 — `verifyAccessToken` rejects tokens missing `handle` claim — treat missing as `null` during transition
- [x] S-M3 — No "resend code" button after registration OTP; SMTP failure = claimed handle with no recovery — **Fixed**: OTP input component now shows "Resend code" button on error with 30s cooldown
- [ ] S-M4 — Legacy `POST /register` returns raw `String(catch)` — extend `publicError()` mapper
- [ ] S-M5 — `displayName` in JWT (1h TTL) — stale after profile update
- [ ] S-M6 — Wildcard CORS on auth server — restrict to known client origins before deployment
- [ ] S-M11 — Magic-link tokens use `crypto.randomUUID` without additional entropy hardening
- [ ] S-M13 — Photon geocoding sends keystrokes to third-party with no user notice — add consent UI or proxy
- [ ] S-M14 — Pulse `REDIRECT_URI` falls back to `window.location.origin` — validate allowed redirect URIs server-side (see S-H3)
- [ ] S-M19 — Legacy `/register` does not lowercase emails — add `lower(email)` unique index
- [x] S-M20 — Refresh tokens in `localStorage` — XSS = permanent account takeover. **Mitigated** by C3 (refresh tokens in HttpOnly cookie) + Phase 4 short access-token TTL (5 min) with `authFetch` silent-refresh. Access token remains in `localStorage` but blast radius is ≤5 min. See [[identity-model]]
- [ ] S-M21 — `/register/begin` differential timing oracle on silent no-op branch
- [ ] S-M34 — Rate limiter trusts `X-Forwarded-For` without reverse-proxy guarantee — see [[rate-limiting]]
- [ ] S-M35 — Redirect URI allowlist matches origin only, not exact URI per RFC 9700 §4.1.3
- [ ] S-M43 — No rate limiting on `/graph/internal/*` S2S endpoints — see [[arc-tokens]]
- [x] S-M44 — `/register-service` stored JWK without verifying it could be imported. **Fixed** — `importKeyFromJwk` called before DB upsert; returns 400 on invalid key — see [[arc-tokens]]
- [x] S-M100 — `peekClaims` used `atob()` which breaks on base64url (`-`/`_` in UUID kids). **Fixed** — `decodeJwtSegment` converts base64url → base64 before decode (RFC 7515 §2) — see [[arc-tokens]]
- [x] S-M101 — `/register-service` stored arbitrary `allowedScopes` without server-side validation. **Fixed** — `PERMITTED_SCOPES` allowlist in `graph-internal.ts`; unknown scopes return 400 — see [[arc-tokens]]
- [x] S-M102 — `resolvePublicKey` cache hit skipped scope check when `tokenScopes` empty. **Fixed** — cache entry now stores `allowedScopes`; scope validated on every cache hit — see [[arc-tokens]]
- [ ] S-M1 (zap) — No rate limiting on Zap API endpoints — see [[rate-limiting]]
- [ ] S-M2 (zap) — CORS wildcard on `@zap/api` — restrict to known client origins
- [ ] S-M3 (zap) — `zapBridge.provisionEventChat` does not verify caller owns event
- [ ] S-M4 (zap) — Non-atomic cross-DB writes in `zapBridge.provisionEventChat`
- [ ] S-M5 (zap) — `addEventChatMember` does not verify chat is type "event"
- [ ] S-M6 (zap) — Truncated UUIDs (12 hex chars = 48 bits)
- [x] S-L1 (multi) — `maxProfiles` column set to 5 but never enforced. **Fixed in P3** — `createProfile` checks count vs `accounts.maxProfiles`
- [x] S-L2 (multi) — Email duplication between `accounts.email` and `users.email`. **Resolved** — `users` table has no `email` column; all email access via JOIN to `accounts`
- [x] S-H1 (session) — In-memory `rotatedSessions` map did not survive restarts or scale across pods. **Fixed** — `RotatedSessionStore` abstraction with Redis-backed impl wired in `osn/api/src/index.ts`; fail-open on Redis error so outages can't manufacture false-positive family revocations — see [[sessions]]
- [x] S-M2 (auth) — `resolveAccessTokenPrincipal` and `resolveAccountId` duplicated across `routes/auth.ts` and `routes/profile.ts`. Extract shared Elysia derive — see [[identity-model]]
- [ ] S-H1 (org) — `listMembers` service returns full profile rows; route projects, but service should restrict
- [ ] S-M1 (org) — `GET /organisations/:handle/members` has no membership gate
- [ ] S-M3 (org) — `getOrganisation` returns `ownerId` internal ID
- [x] S-M1 (passkey) — `deletePasskey` last-passkey/recovery-code lockout guard was SELECT-then-DELETE outside a transaction; two concurrent deletes could bypass it. **Fixed** — gate + delete + security-event insert wrapped in `db.transaction`, returns tagged result; collapses TOCTOU window to zero — see [[identity-model]]
- [x] S-M2 (passkey) — `PATCH /passkeys/:id` had no step-up gate; XSS-captured access token could swap labels to mislead the user before a delete. **Fixed** — rename now uses the same step-up gate as delete (`passkeyDeleteAllowedAmr`); client + UI thread the token through — see [[identity-model]]
- [x] S-M3 (passkey) — Discoverable login did not cross-check assertion `userHandle` against the credential row's `accountId`. **Fixed** — verifier decodes the base64url userHandle and compares to `accounts.passkeyUserId` before completing the ceremony — see [[identity-model]]

### Low

- [ ] S-L1 — Seed data uses reserved handle `"me"` — reservation not DB-enforced
- [ ] S-L2 — `Effect.orDie` in `requireAuth` swallows auth errors — replace with `Effect.either` + 401
- [ ] S-L3 — Tauri CSP is `null` — allowlist `photon.komoot.io`, `maps.google.com`, `*.tile.openstreetmap.org`
- [ ] S-L4 — `createdByAvatar` always null — no avatar claim in JWT
- [x] S-L7 — `jwtSecret` falls back to `"dev-secret"` — **Superseded**: symmetric `OSN_JWT_SECRET` removed entirely; replaced by ES256 key pair (`OSN_JWT_PRIVATE_KEY`/`OSN_JWT_PUBLIC_KEY`); startup guard uses `OSN_ENV` — see [[arc-tokens]]
- [x] S-L29 — `/graph/internal/*` mounted under open CORS. **Fixed** — `cors()` now uses `OSN_CORS_ORIGIN` env var (falls back to `authConfig.origin`); wildcard removed — see [[arc-tokens]]
- [x] S-L32 — `OSN_JWT_SECRET` in `osn/api` fell back to `"dev-secret-change-in-prod"` at startup. **Superseded**: symmetric secret removed; ES256 key pair required in non-local envs (guarded via `OSN_ENV`) — see [[arc-tokens]]
- [x] S-L8 — OTP codes and magic link URLs logged to stdout. **Fixed** — guard tightened to `OSN_ENV` (excludes staging); dev log level defaults to debug so codes are visible without manual config.
- [ ] S-L9 — `imageUrl` allows `data:` URIs — add CSP `img-src` header
- [ ] S-L10 — SimpleWebAuthn loaded from unpkg CDN without SRI hash
- [x] S-L11 — ~~Failed OAuth callback leaves PKCE verifier in `localStorage`~~ — **Obsolete**: PKCE flow deleted (Phase 5b)
- [x] S-L12 — ~~`REDIRECT_URI` from `window.location.origin` — prefer explicit env var~~ — **Obsolete**: `REDIRECT_URI` constant deleted with PKCE cleanup
- [x] S-L13 — ~~PKCE `state` not validated against stored nonce~~ — **Obsolete**: PKCE flow deleted
- [x] S-L40 — `publicKeyCacheSize`, `_setPublicKeyCacheMaxSizeForTest`, `_resetPublicKeyCacheMaxSize` re-exported from `@shared/crypto` public index.ts (test-only symbols in public API). **Fixed** — removed from `index.ts`; tests import direct from `../src/arc` — see [[arc-tokens]]
- [ ] S-L14 — `assertion: t.Any()` on passkey routes — add TypeBox shape validation
- [ ] S-L15 — No reserved-handle blocklist in DB
- [x] S-L101 — `registerWithOsnApi()` silently returned early when `INTERNAL_SERVICE_SECRET` unset. **Fixed** — now throws, caught at startup by `index.ts` — see [[arc-tokens]]
- [x] S-M1 (auth) — ~~`pkceStore` unbounded + no expiry sweep~~ — **Obsolete**: `pkceStore` deleted with PKCE cleanup (Phase 5b)
- [x] S-M2 (auth) — ~~`/authorize` has no rate limiter~~ — **Obsolete**: `/authorize` route deleted with PKCE cleanup (Phase 5b)
- [ ] S-M4 (auth) — No startup assertion that `OSN_JWT_PRIVATE_KEY` has `sign` usage — assert `key.usages.includes("sign")` after import in `loadJwtKeyPair`
- [ ] S-L2 (auth) — Wildcard CORS on `@pulse/api` — restrict to known client origins (mirrors OSN_CORS_ORIGIN pattern) — see [[rate-limiting]]
- [ ] S-L22 — `listRsvps` counts privacy-filtered rows toward `limit` (weak side-channel oracle)
- [x] S-L23 — ~~`pkceStore` has no size bound or eviction sweep~~ — **Obsolete**: `pkceStore` deleted
- [ ] S-L24 — `/token` and legacy `POST /register` have no rate limiting (partial: `authorization_code` grant deleted; `refresh_token` grant and legacy `POST /register` still unthrottled)
- [ ] S-L30 — `createInternalGraphRoutes` has no `loggerLayer` — see [[arc-tokens]], [[observability/overview]]
- [ ] S-L1 (zap) — `jwtVerify` does not restrict algorithms — pass `{ algorithms: ['HS256'] }`
- [ ] S-L2 (zap) — DM chats have no member count enforcement
- [ ] S-L3 (zap) — Admin can remove themselves leaving chat with no admin
- [x] S-L1 (passkey) — `PasskeysView` `window.confirm` race could swap pending delete id on rapid double-click. **Fixed** — every Rename / Delete button is disabled while a step-up ceremony is in flight (`locked()`); pending action stored as a single tagged signal — see [[identity-model]]
- [x] S-L2 (passkey) — `listPasskeys` exposed raw `credentialId` to the browser without UI need. **Fixed** — projection drops `credentialId`; opaque `pk_<hex>` `id` is the only handle reaching the client — see [[identity-model]]
- [x] S-L3 (passkey) — Fallback "no caller session" branch in `deletePasskey` nuked all sessions silently. **Fixed** — branch now `Effect.logWarning`s the anomalous condition before the wipe — see [[sessions]]
- [x] S-L4 (passkey) — `DELETE /passkeys/:id` accepted OTP step-up via reused `recoveryGenerateAllowedAmr`. **Fixed** — new `passkeyDeleteAllowedAmr` config knob defaults to `["webauthn"]` (passkey-only); operators can widen if their threat model requires — see [[step-up]]
- [x] S-L5 (passkey) — `verifyPasskeyAssertion` reflected raw `@simplewebauthn/server` error text to the client (verifier-probe oracle). **Fixed** — fixed `"Passkey verification failed"` on the wire; cause logged via `Effect.logWarning` — see [[identity-model]]
- [ ] S-L1 (org) — Org creation rate limit (60/min) shared with member ops
- [ ] S-L3 (org) — TOCTOU gap in handle uniqueness check
- [ ] S-L1 (social) — Access tokens in `localStorage` via `StorageLive` — XSS = token exfiltration. Inherited from `@osn/client`; revisit alongside S-M20 by moving to HttpOnly cookie BFF or `sessionStorage` with tight TTL — see [[identity-model]]
- [ ] S-L4 (recs) — `mutualCount` discloses graph-inference signal; adversary with many test accounts can combine counts to deduce third-party connection sets. Consider bucketing (e.g. "10+") above a threshold — see [[social-graph]]
- [ ] S-L1 (auth-fetch) — `OsnAuthService.authFetch` attaches `Authorization: Bearer` + `credentials: include` to any URL; no origin allowlist. Add `allowedOrigins` to `OsnAuthConfig` and skip header attachment off-list (defence-in-depth against mis-routed fetches / injected URLs) — see [[identity-model]]
- [ ] S-L2 (security-events) — `notifyRecovery` logs a stable `"notify_dispatch_failed"` message, but if `AuthError.message` ever embeds the mailer-provider response body a future refactor could leak the recipient email past the key-based redactor. Pin the log message shape with a test and assert the raw cause only appears on the span — see [[recovery-codes]]
- [ ] S-L3 (security-events) — `securityEventList` + `securityEventAck` limiters are keyed per-IP via `getClientIp` (`osn/api/src/routes/auth.ts`), but both endpoints are authenticated. Key by `claims.profileId` to strengthen the CGNAT / botnet-fan-out threat model (same pattern as `/recommendations/connections`) — see [[rate-limiting]]

### Recovery / passkey-primary (Phase 5 prerequisites)
- [x] M-PK1b — Out-of-band recovery-code regeneration + consumption notification. `security_events` audit table covers both recovery code kinds; `/account/security-events[/:id/ack | /ack-all]` routes require step-up (S-M1) and the Settings banner uses optimistic local removal (P-I3). **Shipped** — see [[recovery-codes]] and `[[changelog/completed-features]]`

---

## Performance Backlog

Open findings only. Completed fixes archived in [[changelog/performance-fixes]].

### Warning

- [ ] P-W1 (zap) — `listChats` returns unbounded results (no pagination)
- [ ] P-W2 (zap) — `addMember` fetches all members to check count. Use `COUNT(*)` or catch unique constraint
- [ ] P-W3 (zap) — `provisionEventChat` non-atomic cross-DB writes
- [ ] P-W4 (zap) — `getChatMembers` returns all members without pagination
- [x] P-W2 — `resolvePublicKey` hits DB when `tokenScopes` provided even if `kid` cache is warm. **Fixed** — cache entry now stores `CryptoKey` + `allowedScopes`; scope validated from cache on hit, no DB round-trip — see [[arc-tokens]]
- [x] P-W100 — `publicKeyCache` unbounded under key rotation churn. **Fixed** — `MAX_CACHE_SIZE` cap with oldest-entry eviction on write — see [[arc-tokens]]
- [x] P-W101 — `peekClaims` decoded payload before checking header validity. **Fixed** — header decoded first; payload decode gated on `kid` present — see [[arc-tokens]]
- [x] P-W102 — `evictExpiredTokens` O(n) scan on every `getOrCreateArcToken` call. **Fixed** — internal debounced sweep (`maybeSweepExpiredTokens`) runs at most once per 30 s; public `evictExpiredTokens` still sweeps immediately — see [[arc-tokens]]
- [x] P-W1 (session) — `trackRotatedSession` swept in-memory Map O(n) on every refresh. **Fixed** — Redis-backed store uses native PX TTL per key; in-memory fallback keeps the existing O(1) amortised FIFO sweep bounded by `ROTATED_SESSIONS_MAX` — see [[sessions]]
- [ ] P-W2 (session) — S-H1 migration adds extra `findProfileById` DB round-trip on every profile endpoint. Embed `accountId` in access token or add profileId→accountId cache — see [[identity-model]]
- [ ] P-W3 — `sendConnectionRequest` two sequential independent DB reads — use `Effect.all` with `concurrency: "unbounded"`
- [ ] P-W3 (jwks) — `extractClaims` in pulse/api serialises JWKS resolve before DB I/O on read-only routes — parallelise with `Promise.all` for anonymous-capable endpoints — see [[arc-tokens]]
- [ ] P-W4 — Auth Maps (`otpStore`, `magicStore`) never evict expired entries — see [[redis]] (`pkceStore` removed with Phase 5b)
- [ ] P-I4 (auth) — `/login/magic/verify` has no rate limiter — add `magicVerify: RateLimiterBackend` (10/60s per-IP, mirror `/login/otp/complete`). Pre-existing, not a regression; parity with the rest of `/login/*` — see [[rate-limiting]]
- [ ] P-W1 (pulse) — Duplicate event DB load per RSVP route: `loadVisibleEvent` fetches the row for the access gate; `listRsvps`/`rsvpCounts` re-fetch the same row internally. Thread the loaded `Event` into service functions — see [[s2s-patterns]]
- [ ] P-W3 (pulse) — `listTodayEvents` has no `LIMIT` clause; fetches all matching rows for the day into memory — see [[event-access]]
- [ ] P-W5 — Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (N individual writes)
- [ ] P-W10 — `RegistrationClient.checkHandle` has no `AbortController` — debounced bursts leave multiple in-flight requests
- [ ] P-W11 — `beginRegistration` issues two parallel queries instead of single `WHERE email = ? OR handle = ?`
- [ ] P-W22 — Two `Effect.runPromise` calls per internal graph request — consolidate when S2S throughput grows — see [[arc-tokens]]
- [x] P-W25 — `publicKeyCache` uses FIFO eviction; upgrade to LRU so the most-recently-used keys are kept under churn. **Fixed** — side-timestamp map (`publicKeyLastAccess`) records last-access in ms; O(1) touch on hit, O(n) scan only at eviction (DB-miss path) — see [[arc-tokens]]
- [x] P-W26 — `publicKeyCache` hit path used Map delete+re-insert for LRU touch (O(log n) + allocation on hot path). **Fixed** — replaced with `publicKeyLastAccess.set(kid, Date.now())` (single map write) — see [[arc-tokens]]
- [x] P-W27 — `allowedScopes` stored as raw comma-separated string; split+includes on every cache-hit scope check. **Fixed** — stored as `Set<string>` parsed once at DB-miss time; hit path uses `Set.has()` O(1) — see [[arc-tokens]]
- [x] P-I16 — `tokenCache` used FIFO eviction (insertion-order head eviction). **Fixed** — `tokenLastAccess` side-map added; `getOrCreateArcToken` evicts true LRU entry on overflow; sweep/clear functions maintain the side map — see [[arc-tokens]]
- [ ] P-W23 — `tailwind-merge` (~12-14 KB) in initial bundle — see [[component-library]]
- [ ] P-W24 — `cn()` with signal reads replaces `classList` — avoid in `<For>` loops — see [[component-library]]
- [x] P-W3 (org) — Sequential queries in `removeMember` and `updateOrganisation` could be parallelised. **Fixed** — `callerMember`+`targetMember` in `removeMember` and `orgRows`+`memberRows` in `updateOrganisation` now use `Effect.all({ concurrency: 2 })`. `resolveOrg`+`resolveHandle` in the three member routes now run via `Promise.all`
- [ ] P-W6 (recs) — No caching/pagination contract on `/recommendations/connections`. Every request re-runs the FOF pipeline. Add short-lived per-caller cache (5-15 min) and/or `generated_at` timestamp so clients can detect cached responses — see [[social-graph]]
- [ ] P-W7 (recs) — FOF aggregation in JS after capping fan-out (current). Next step: push aggregation to SQL via `SELECT candidate_id, COUNT(*) FROM (...) GROUP BY candidate_id ORDER BY count DESC LIMIT ?`. Add compound indexes `connections(status, requester_id)` + `connections(status, addressee_id)` — see [[social-graph]]
- [ ] P-W2 (auth-ttl) — 3600s → 300s access-token TTL raises `/token` write load ~12× per session (DELETE+INSERT on `sessions` each refresh). Single-flight refresh (shipped as S-H1 fix) caps concurrent multiplication but doesn't change the baseline. Before horizontal-scale promotion: (a) watch `osn.auth.token.refresh` rate, (b) consider window-based session rotation (only rotate the refresh-token row when `now - createdAt > rotateAfterMs`) so the common case becomes "issue new access token, leave sessions row untouched" while still preserving C2 reuse detection — see [[identity-model]]
- [x] P-W1 (passkey) — `completePasskeyRegistration` MAX_PASSKEYS race guard was SELECT-then-INSERT outside a transaction. **Fixed** — both statements now run inside `db.transaction`, collapsing the TOCTOU window to zero on SQLite — see [[identity-model]]
- [x] P-I1 (passkey) — `deletePasskey` issued two SELECTs against `passkeys` for the same account. **Fixed** — collapsed into one query inside the transaction; the per-account 10-row cap means the in-memory `.some(…)` check is O(1) — see [[identity-model]]
- [x] P-I2 (passkey) — `loginChallenges` map had no hard cap, only TTL eviction. **Fixed** — `MAX_LOGIN_CHALLENGES = 10_000` ceiling enforced on both the identifier-keyed and discoverable (`__disc__:<uuid>`) insert paths — see [[identity-model]]

### Info

- [x] P-I1 — `evictExpiredTokens` iterates full cache on every `getOrCreateArcToken` call. **Fixed as P-W102** — debounced internal sweep — see [[arc-tokens]]
- [x] P-I100 — `rotateKey` retry had no jitter; simultaneous failures on horizontal instances caused thundering-herd on `/register-service`. **Fixed** — retry delay is `5 min ± 30 s` — see [[arc-tokens]]
- [x] P-I101 — `startKeyRotation` scheduled a rotation timer for the pre-distributed key path that always silently no-oped. **Fixed** — pre-distributed key path removed entirely; all rotation is ephemeral auto-rotation — see [[arc-tokens]]
- [ ] P-I2 — `new TextEncoder()` allocated per JWT sign/verify call — cache or import `CryptoKey` once
- [ ] P-I3 — `new TextEncoder()` per `verifyPkceChallenge` call — move to module scope
- [ ] P-I1 (pulse) — `Register`/`SignIn` eagerly imported in `Header.tsx` — lazy-load for authenticated users — see [[component-library]]
- [ ] P-I2 (pulse) — Module-level `createSignal` in `createEventSignal.ts` outside reactive owner — wrap in `createRoot` if effects added later
- [ ] P-I4 — Deprecated `bx()` still exported from `@osn/ui` — remove once no external consumers remain — see [[component-library]]
- [ ] P-I5 — Auth Dialog components always mounted in EventList (vs conditional `<Show>`) — negligible for two forms but revisit if dialogs grow heavier
- [ ] P-I4 — `AuthProvider` reconstructs Effect `Layer` on every render — wrap with `createMemo`
- [ ] P-I5 — `/graph/internal/connections` and `/close-friends` no `offset` parameter — see [[arc-tokens]]
- [ ] P-I1 (recovery) — `countActiveRecoveryCodes` SELECTs full rows then filters in JS to compute count. Bounded to ~10 rows today so impact is nil, but the helper returns secret-bearing `code_hash` values over the wire just to take a length. Replace with `SELECT SUM(CASE WHEN used_at IS NULL THEN 1 ELSE 0 END) AS active, COUNT(*) AS total FROM recovery_codes WHERE account_id = ?` — see [[recovery-codes]]
- [ ] P-I2 (recovery) — `consumeRecoveryCode` issues SELECT + separate transaction. Collapse into a single conditional update: `UPDATE recovery_codes SET used_at = ? WHERE id = ? AND code_hash = ? AND account_id = ? AND used_at IS NULL RETURNING id` — one atomic round-trip, single-use race-free on every backend — see [[recovery-codes]]
- [ ] P-I3 (recovery) — `generateRecoveryCodesForAccount` computes `genId()` + `hashRecoveryCode()` synchronously for the whole batch before the DB transaction. Nil impact at `RECOVERY_CODE_COUNT = 10` with SHA-256; flag only as a precondition for any future switch to a memory-hard KDF — wrap the `rows.map(...)` in `Effect.sync` so the runtime can yield — see [[recovery-codes]]
- [ ] P-I2 (security-events) — `listUnacknowledgedSecurityEvents` returns up to 50 rows with no pagination token. Fine for today's single-kind taxonomy, but silently drops older rows if the list grows past the cap. Add `?before=<createdAt>` + `{ events, hasMore }` once another kind is introduced — see [[recovery-codes]]
- [ ] P-I4 (security-events) — `GET /account/security-events` has no `Cache-Control` header. Low-impact today (the query is cheap and the banner fetches once per mount); add `Cache-Control: private, no-store` + a weak ETag on `MAX(created_at)` once the banner starts polling or is embedded outside Settings — see [[recovery-codes]]
- [ ] P-I5b — `completePasskeyLogin` calls `findProfileByEmail` redundantly — `pk.userId` already on passkey row
- [x] P-I10 — `beginPasskeyRegistration` fetches all passkeys without `LIMIT` — `MAX_PASSKEYS_PER_ACCOUNT = 10` enforced at begin and race-safely re-checked at complete — see [[identity-model]]
- [ ] P-I6 — Duplicate index on `users.email` — `unique()` already creates one implicitly in SQLite
- [ ] P-I7 — Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *`
- [ ] P-I8 — `resolveHandle` re-fetches user from DB when handler already has the User row
- [ ] P-I9 — Graph list endpoints load entire result set before slicing — add DB-level `LIMIT`/`OFFSET`
- [ ] P-I2 (pulse) — Missing `(event_id, status)` composite index on `event_rsvps`; status filter applied as a post-index scan — add `index("event_rsvps_event_status_idx").on(t.eventId, t.status)` to `pulse/db` schema
- [ ] P-I14 — `GET /events/:id/ics` has no `Cache-Control` / `ETag` headers
- [ ] P-I15 — `rsvpCounts` calls `loadEvent(eventId)` redundantly (route already gates via `loadVisibleEvent`)
- [ ] P-I1 (client) — Duplicated `authGet`/`authPost`/`authPatch`/`authDelete` helpers across `graph.ts`, `organisations.ts`, `recommendations.ts`. Factor to `@osn/client/src/lib/auth-fetch.ts` parameterised by error-class constructor — see [[component-library]]
- [ ] P-I4 (social) — List pages (`ConnectionsPage`, `OrganisationsPage`) have no pagination UI. Server supports `limit`/`offset` but users with &gt;50 connections silently lose visibility. Add infinite-scroll via `IntersectionObserver` or paginator

---

## Auth Improvements (Copenhagen Book Audit)

Findings from auditing OSN auth against [The Copenhagen Book](https://thecopenhagenbook.com/) by pilcrowonpaper. Organised in priority phases.

### Phase 1 — Session Revocation (Critical)
- [x] C1: Server-side session table in `osn/db` — store hashed refresh tokens, enable revocation — see [[identity-model]]
- [x] C2: Refresh token rotation on `/token` refresh grant — new token each refresh, detect reuse — see [[identity-model]]
- [x] H1: Invalidate all sessions on security events (passkey registration, email change) — see [[identity-model]]

### Phase 2 — Token Storage + Transport (Critical)
- [x] C3: Move refresh tokens from `localStorage` to `HttpOnly; Secure; SameSite=Lax` cookies (BFF pattern) — see [[identity-model]]
- [x] M1: Add Origin header validation middleware (required once cookies carry auth state) — see [[rate-limiting]]

### Phase 3 — Defense-in-Depth (High)
- [x] H2: SHA-256 hash magic link tokens before storage in `magicStore` — see [[identity-model]]
- [x] H3: SHA-256 hash OTP codes before storage in `pendingRegistrations` — see [[identity-model]]
- [ ] H4: Migrate `@zap/api` from shared-secret JWT verification to JWKS-based (align with Pulse) — see [[arc-tokens]]

### Phase 4 — Hardening (Medium)
- [x] M2: Recovery codes — 10 × 64-bit single-use codes, SHA-256 hashed at rest, revoke-all-sessions on consume. See [[recovery-codes]] + [[identity-model]]
- [ ] M3: Email max length validation (≤255 chars) in `EmailSchema`
- [ ] M5: Increase registration OTP from 6-digit to 8-digit (or 6-char alphanumeric)
- [x] C3-follow-up: Access token TTL cut from 1h → 5min; client `authFetch` silent-refreshes on 401 via the HttpOnly session cookie. Caps XSS blast radius on the remaining localStorage secret. See [[identity-model]]

### Phase 5 — Passkey-primary (Next)
- [x] S-H1 (session): Move in-memory `rotatedSessions` map to Redis so C2 reuse detection survives restart + scales across processes. **Done** — see [[sessions]]
- [ ] Device/session listing + revocation UI (`GET /sessions`, `DELETE /sessions/:id`). Requires `sessions.user_agent`/`ip_hash` columns. Depends on: nothing.
- [ ] M-PK: Switch to passkey-primary login, demote OTP/magic-link to recovery-only paths gated behind a recovery code. Depends on: M2 ✅

---

## Deferred Decisions

| Decision | Context | Revisit When |
|----------|---------|--------------|
| Social media platform name | Need a catchy name | Before starting Phase 3 |
| Signal vs MLS for Zap group chats — see [[zap]] | Sender-keys is simpler; MLS scales past ~50 members | Before Zap M2 |
| Zap media storage (images / voice / video) | Needs E2E-friendly blob storage; SQLite-only won't cut it | When Zap M2 lands |
| Effect.ts adoption | Trial underway in `pulse/api` | After more service coverage |
| Supabase migration | Currently SQLite | When scaling needed |
| Android support | iOS priority | Phase 3 |
| Self-hosting | Enterprise use case | Phase 3 |
| Payment handling | Deferred for Pulse ticketing | After core Pulse features |
| Two-way calendar sync | Currently one-way (Pulse → external) | Phase 2 |
| Community event-ended reporting | 15–20 attendees auto-finish; host notified | When attendee/messaging features land |
| Max event duration | Prompt user when creating events without endTime | When Pulse event creation UI is built |
| Redis provider — see [[redis]] | Upstash (serverless, free tier) vs Redis Cloud vs self-hosted | When deploying beyond localhost |
| DB table rename `users` → `profiles` | Table represents profiles; renaming is migration-heavy for minimal benefit | Only if it causes genuine confusion |
| S2S scaling — see [[s2s-patterns]], [[arc-tokens]], [[s2s-migration]] | `pulse/api` graphBridge now uses HTTP + ARC. Remaining: `zap/api` bridge still uses direct import | When `zap/api` needs horizontal scaling |
| Per-app blocking — see [[social-graph]] | Blocks global across all OSN apps. Per-app scope deferred | When Messaging or third-party app needs independent block lists |
| `@chenglou/pretext` for Zap virtual scroll — see [[zap]] | Pure-JS text measurement/layout. Enables virtualised message lists | When Zap UI needs message list virtualisation |
| Profile transfer between accounts | Meta supports unlinking/relinking profiles | After multi-account ships (P6) |
| Per-profile notification email | Profiles might want separate contact emails | When notification system is built |
| Profile-level 2FA | Currently 2FA would be account-wide (passkeys on accounts) | When 2FA is implemented |
| Cross-profile content sharing | Reposting between own profiles | Phase 2 social features |
| Max profiles per account | Set to 5 via `accounts.maxProfiles`; make configurable? | Before launch |
| Self-interaction policy | Two profiles from same account CAN interact (preventing it leaks the link) | Multi-account P6 privacy audit |
| Build-time `cn()` evaluation — see [[component-library]] | `tailwind-merge` runs at runtime. Options: Vite plugin, drop to `clsx`-only | When bundle size is a concern |
| Tauri passkey support on iOS | Webview lacks WebAuthn natively — auto-skips passkey step. Options: `tauri-plugin-webauthn`, custom plugin, wait for upstream | When iOS build of Pulse is ready for sign-in |

---

## Future

### Phase 2: Polish
- [ ] Advanced discovery algorithms
- [ ] Venue pages with DJ schedules
- [ ] Recurring event management UI
- [ ] Calendar integration improvements
- [ ] Accessibility audit

### Phase 3: Expansion
- [ ] Social media platform (spec exists, implementation deferred)
- [ ] Android support
- [ ] Self-hosting capabilities
- [ ] Third-party API ecosystem
- [ ] Supabase migration (from SQLite)
