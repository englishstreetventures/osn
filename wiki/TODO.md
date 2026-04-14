# OSN Project TODO

Progress tracking and deferred decisions. Completed items archived in `[[changelog/]]`. For full spec see README.md. For code patterns see CLAUDE.md. For detailed system docs see [[index]].

## Up Next

- [x] Multi-account P3 — Profile CRUD: `createProfileService()` (create, delete, set default), `/profiles` routes, `maxProfiles` enforcement (S-L1), cascade-delete profile data, observability (counter + histogram + spans)
- [ ] Multi-account P4 — Client SDK: multi-session storage (`@osn/client:account_session`, `@osn/client:active_profile`, per-profile access tokens), `listProfiles()`, `switchProfile()`, `createProfile()`, `deleteProfile()` methods on `OsnAuthService`
- [ ] Multi-account P5 — Profile UI: profile switcher component in `@osn/ui`, profile creation form, onboarding for additional profiles
- [ ] Multi-account P6 — Privacy audit: verify `accountId` never leaks in API responses / tokens / logs, rate-limit per-profile (not per-account), pen-test correlation attacks between profiles
- [ ] Provision Grafana Cloud free tier + wire `OTEL_EXPORTER_OTLP_ENDPOINT` + headers into deploy env — see [[observability-setup]]
- [ ] Build first observability dashboards (HTTP RED, auth funnel, ARC verification, events CRUD) — see [[observability/overview]]
- [ ] Zap route-level tests + zapBridge tests (T-R1, T-M1 from review)
- [ ] Zap rate limiting on write endpoints (S-M1) — see [[rate-limiting]]

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

## OSN Core (`osn/app` + `osn/core`)

- [x] Multi-account profile CRUD (P3) — create/delete/set-default profiles, maxProfiles enforcement, cascade delete, observability
- [ ] Multi-account client SDK (P4) — multi-session storage, profile switching
- [ ] Multi-account UI (P5) — profile switcher component
- [ ] Multi-account privacy audit (P6) — accountId leak verification, per-profile rate limits
- [ ] Per-app vs global blocking logic (deferred — global blocking across all OSN apps for now)
- [ ] Interest profile selection (onboarding)
- [ ] Third-party app authorization flow
- [ ] Organisation frontend — management UI in Pulse or standalone `@osn/social` Tauri app
- [ ] Unified `handles` reservation table (user + org handles share namespace; currently enforced at service layer — see Deferred Decisions)

---

## Zap (`zap/app` + `zap/api` + `zap/db`)

OSN's messaging app. Stack matches Pulse (Bun, Tauri+Solid, Elysia+Eden, Drizzle+SQLite, Effect.ts) unless a real reason emerges to diverge. Signal Protocol lives in `@osn/crypto`, not `zap/`.

### M0 — Scaffold (remaining)

- [ ] `bunx create-tauri-app` for `@zap/app` (iOS target enabled, Solid template)
- [ ] `@zap/app` consumes `@osn/client` + `@osn/ui/auth` for sign-in (re-uses `<SignIn>` / `<Register>` from Pulse)
- [ ] Register `zap-app` and `zap-api` in `service_accounts` (ARC token issuer rows)

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
- [ ] S2S graph access: add `@osn/core` + `@osn/db` deps; use `createGraphService()` read-only for event filtering — first ARC token consumer
- [ ] OSN/messaging domain modules
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers

### Database (`osn/db`, `pulse/db`)

- [ ] OSN Core: session schema (JWT-based for now; DB storage deferred)
- [ ] Pulse: event series schema
- [ ] Add indexes on `status` and `category` columns in pulse-db events schema

### Crypto (`osn/crypto`)

- [ ] JWKS URL fallback in `resolvePublicKey` for third-party apps

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
- [ ] `pkceStore` → Redis with TTL + size bound (resolves S-L23)
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

- [ ] S-H21 — Dev-mode `console.log` of OTP codes + recipient email in `osn/core/src/services/auth.ts`. Replace with `Effect.logDebug` + structured annotations. Deferred to console migration PR.

### Medium

- [ ] S-M1 — `verifyAccessToken` rejects tokens missing `handle` claim — treat missing as `null` during transition
- [ ] S-M3 — No "resend code" button after registration OTP; SMTP failure = claimed handle with no recovery
- [ ] S-M4 — Legacy `POST /register` returns raw `String(catch)` — extend `publicError()` mapper
- [ ] S-M5 — `displayName` in JWT (1h TTL) — stale after profile update
- [ ] S-M6 — Wildcard CORS on auth server — restrict to known client origins before deployment
- [ ] S-M11 — Magic-link tokens use `crypto.randomUUID` without additional entropy hardening
- [ ] S-M13 — Photon geocoding sends keystrokes to third-party with no user notice — add consent UI or proxy
- [ ] S-M14 — Pulse `REDIRECT_URI` falls back to `window.location.origin` — validate allowed redirect URIs server-side (see S-H3)
- [ ] S-M19 — Legacy `/register` does not lowercase emails — add `lower(email)` unique index
- [ ] S-M20 — Refresh tokens in `localStorage` — XSS = permanent account takeover. Swap to keychain/HttpOnly cookies
- [ ] S-M21 — `/register/begin` differential timing oracle on silent no-op branch
- [ ] S-M34 — Rate limiter trusts `X-Forwarded-For` without reverse-proxy guarantee — see [[rate-limiting]]
- [ ] S-M35 — Redirect URI allowlist matches origin only, not exact URI per RFC 9700 §4.1.3
- [ ] S-M43 — No rate limiting on `/graph/internal/*` S2S endpoints — see [[arc-tokens]]
- [ ] S-M1 (zap) — No rate limiting on Zap API endpoints — see [[rate-limiting]]
- [ ] S-M2 (zap) — CORS wildcard on `@zap/api` — restrict to known client origins
- [ ] S-M3 (zap) — `zapBridge.provisionEventChat` does not verify caller owns event
- [ ] S-M4 (zap) — Non-atomic cross-DB writes in `zapBridge.provisionEventChat`
- [ ] S-M5 (zap) — `addEventChatMember` does not verify chat is type "event"
- [ ] S-M6 (zap) — Truncated UUIDs (12 hex chars = 48 bits)
- [x] S-L1 (multi) — `maxProfiles` column set to 5 but never enforced. **Fixed in P3** — `createProfile` checks count vs `accounts.maxProfiles`
- [x] S-L2 (multi) — Email duplication between `accounts.email` and `users.email`. **Resolved** — `users` table has no `email` column; all email access via JOIN to `accounts`
- [ ] S-H1 (org) — `listMembers` service returns full profile rows; route projects, but service should restrict
- [ ] S-M1 (org) — `GET /organisations/:handle/members` has no membership gate
- [ ] S-M3 (org) — `getOrganisation` returns `ownerId` internal ID

### Low

- [ ] S-L1 — Seed data uses reserved handle `"me"` — reservation not DB-enforced
- [ ] S-L2 — `Effect.orDie` in `requireAuth` swallows auth errors — replace with `Effect.either` + 401
- [ ] S-L3 — Tauri CSP is `null` — allowlist `photon.komoot.io`, `maps.google.com`, `*.tile.openstreetmap.org`
- [ ] S-L4 — `createdByAvatar` always null — no avatar claim in JWT
- [ ] S-L7 — `jwtSecret` falls back to `"dev-secret"` — throw at startup in production
- [ ] S-L8 — OTP codes and magic link URLs logged to stdout — guard with `NODE_ENV`
- [ ] S-L9 — `imageUrl` allows `data:` URIs — add CSP `img-src` header
- [ ] S-L10 — SimpleWebAuthn loaded from unpkg CDN without SRI hash
- [ ] S-L11 — Failed OAuth callback leaves PKCE verifier in `localStorage`
- [ ] S-L12 — `REDIRECT_URI` from `window.location.origin` — prefer explicit env var
- [ ] S-L13 — PKCE `state` not validated against stored nonce
- [ ] S-L14 — `assertion: t.Any()` on passkey routes — add TypeBox shape validation
- [ ] S-L15 — No reserved-handle blocklist in DB
- [ ] S-L22 — `listRsvps` counts privacy-filtered rows toward `limit` (weak side-channel oracle)
- [ ] S-L23 — `pkceStore` has no size bound or eviction sweep
- [ ] S-L24 — `/token` and legacy `POST /register` have no rate limiting
- [ ] S-L29 — `/graph/internal/*` mounted under open CORS — see [[arc-tokens]]
- [ ] S-L30 — `createInternalGraphRoutes` has no `loggerLayer` — see [[arc-tokens]], [[observability/overview]]
- [ ] S-L1 (zap) — `jwtVerify` does not restrict algorithms — pass `{ algorithms: ['HS256'] }`
- [ ] S-L2 (zap) — DM chats have no member count enforcement
- [ ] S-L3 (zap) — Admin can remove themselves leaving chat with no admin
- [ ] S-L1 (org) — Org creation rate limit (60/min) shared with member ops
- [ ] S-L3 (org) — TOCTOU gap in handle uniqueness check

---

## Performance Backlog

Open findings only. Completed fixes archived in [[changelog/performance-fixes]].

### Warning

- [ ] P-W1 (zap) — `listChats` returns unbounded results (no pagination)
- [ ] P-W2 (zap) — `addMember` fetches all members to check count. Use `COUNT(*)` or catch unique constraint
- [ ] P-W3 (zap) — `provisionEventChat` non-atomic cross-DB writes
- [ ] P-W4 (zap) — `getChatMembers` returns all members without pagination
- [ ] P-W2 — `resolvePublicKey` hits DB despite warm cache — cache `CryptoKey` + `allowedScopes` together — see [[arc-tokens]]
- [ ] P-W3 — `sendConnectionRequest` two sequential independent DB reads — use `Effect.all` with `concurrency: "unbounded"`
- [ ] P-W4 — Auth Maps (`otpStore`, `magicStore`, `pkceStore`) never evict expired entries — see [[redis]]
- [ ] P-W5 — Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (N individual writes)
- [ ] P-W10 — `RegistrationClient.checkHandle` has no `AbortController` — debounced bursts leave multiple in-flight requests
- [ ] P-W11 — `beginRegistration` issues two parallel queries instead of single `WHERE email = ? OR handle = ?`
- [ ] P-W22 — Two `Effect.runPromise` calls per internal graph request — consolidate when S2S throughput grows — see [[arc-tokens]]
- [ ] P-W23 — `tailwind-merge` (~12-14 KB) in initial bundle — see [[component-library]]
- [ ] P-W24 — `cn()` with signal reads replaces `classList` — avoid in `<For>` loops — see [[component-library]]
- [ ] P-W3 (org) — Sequential queries in `removeMember`/`updateMemberRole` could be parallelised

### Info

- [ ] P-I1 — `evictExpiredTokens` iterates full cache on every `getOrCreateArcToken` call — throttle or remove
- [ ] P-I2 — `new TextEncoder()` allocated per JWT sign/verify call — cache or import `CryptoKey` once
- [ ] P-I3 — `new TextEncoder()` per `verifyPkceChallenge` call — move to module scope
- [ ] P-I4 — `AuthProvider` reconstructs Effect `Layer` on every render — wrap with `createMemo`
- [ ] P-I5 — `/graph/internal/connections` and `/close-friends` no `offset` parameter — see [[arc-tokens]]
- [ ] P-I5b — `completePasskeyLogin` calls `findProfileByEmail` redundantly — `pk.userId` already on passkey row
- [ ] P-I6 — Duplicate index on `users.email` — `unique()` already creates one implicitly in SQLite
- [ ] P-I7 — Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *`
- [ ] P-I8 — `resolveHandle` re-fetches user from DB when handler already has the User row
- [ ] P-I9 — Graph list endpoints load entire result set before slicing — add DB-level `LIMIT`/`OFFSET`
- [ ] P-I14 — `GET /events/:id/ics` has no `Cache-Control` / `ETag` headers
- [ ] P-I15 — `rsvpCounts` calls `loadEvent(eventId)` redundantly (route already gates via `loadVisibleEvent`)

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
| S2S scaling — see [[s2s-patterns]], [[arc-tokens]], [[s2s-migration]] | Current: direct package import. Migrate to HTTP + ARC when scaling horizontally | When multi-process deployment needed |
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
