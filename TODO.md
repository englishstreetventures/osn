# OSN Project TODO

Progress tracking and deferred decisions. For full spec see README.md. For code patterns see CLAUDE.md.

## Up Next

- [ ] Zap M0 scaffold — `@zap/app` (Tauri+Solid), `@zap/api` (Elysia), `@zap/db` (Drizzle)
- [ ] Wire Pulse event chat to Zap once M2 lands (replace `EventChatPlaceholder`)
- [ ] Pulse: "What's on today" default view
- [ ] Landing page: design and content
- [ ] S-H1 — Rate limit registration + login auth endpoints (per-IP / per-email throttle)
- [ ] S-H3 — Open redirect in `/magic/verify` — fix before any deployment
- [ ] S-H4 — Make PKCE mandatory at `/token` (drop the `if (state)` conditional; affects every code-issuing flow)
- [ ] S-H5 — Migrate the hosted `/authorize` HTML page to send `Authorization: Bearer <token>` to `/passkey/register/*`, then remove the legacy unauth'd path
- [ ] ARC token verification middleware on internal graph routes (`/graph/internal/*`)

---

## Pulse (`pulse/app` + `pulse/api` + `pulse/db`)

- [x] Initialize Tauri app with SolidJS
- [x] iOS target configured
- [x] Event data model and schema
- [x] Event CRUD operations (list, today, get, create, update, delete)
- [x] Event CRUD UI (create form, delete, Eden client, shadcn tokens)
- [x] Event lifecycle auto-transitions (on-read, no background job)
- [x] Location autocomplete (`LocationInput` with debounce/abort)
- [x] Auth callback handler (`CallbackHandler`)
- [x] Test coverage: utils, LocationInput, CreateEventForm end-time validation
- [x] Test coverage: EventCard, CreateEventForm (full), EventList (auth/unauth)
- [x] Toast notification system (solid-toast: event created, deleted, create/delete errors)
- [x] Registration UI: multi-step flow (email + handle + display name → OTP → passkey enrolment), live handle availability check, auto-login on completion via `adoptSession`
- [x] Coordinate storage (lat/lng from Photon autocomplete) + Maps button on EventCard
- [x] Full event view at `/events/:id` with shareable URL (client routing via `@solidjs/router`)
- [x] Map preview in expanded event view (Leaflet + OpenStreetMap, no API key)
- [x] iCal export (ICS) — `GET /events/:id/ics` + Add-to-calendar button
- [x] RSVP service: upsert/list/counts/invite, cross-DB join with `@osn/db` user displays
- [x] RSVP visibility filtering — public / connections / private guest list, with per-attendee `attendanceVisibility` (`connections` / `close_friends` / `no_one`) honoured server-side
- [x] Event public/private discovery flag — `listEvents` filters out private events from non-owners
- [x] Join policy — `open` vs `guest_list` (invited users only)
- [x] Allow-interested toggle for events that don't accept "Maybe" RSVPs
- [x] Communications config (`commsChannels`) and stubbed blast log (`event_comms` table); organiser-only `POST /events/:id/comms/blasts`
- [x] Per-step info popovers in `CreateEventForm`
- [x] `pulse_users` table for Pulse-side user settings (separate from OSN identity)
- [x] `PATCH /me/settings` route for attendance visibility
- [x] Event chat placeholder (will be replaced with Zap M2)
- [ ] "What's on today" default view
- [ ] Prompt for max event duration when creating events without an endTime
- [ ] Event discovery (location, category, datetime, friends, interests)
- [ ] Recurring events (series + instances)
- [ ] Event group chats (via Zap once M2 lands — placeholder shipped)
- [ ] Hidden attendance option (delivered above as `attendanceVisibility = "no_one"`)
- [ ] Organizer tools (moderation, blacklists)
- [ ] Venue pages
- [ ] Real SMS/email comms providers — `sendBlast` is stubbed (writes to `event_comms`); plug in actual delivery
- [ ] Tighten Tauri CSP to allowlist `*.tile.openstreetmap.org` for the new Leaflet tile loads (rolls into S-L3)
- [ ] Drizzle: `@pulse/db` test helpers (`tests/schema.test.ts`, `tests/seed.test.ts`, `pulse/api/tests/helpers/db.ts`) hand-roll the SQL schema in three places — extract a shared `createSchemaSql()` helper so adding a column is a one-file change
- [ ] Verified-organisation tier (Pulse phase 2): organisation accounts can run events over `MAX_EVENT_GUESTS` (1000) via a per-event support flow that bumps the cap. Required for conferences / festivals / large weddings. Blocks: org claim on JWT, support request flow, billing, dashboards.
- [ ] Once `@osn/core` exposes a directional `isCloseFriendOf(attendee, viewer)` graph helper, drop the `getCloseFriendsOf` SQL query from `pulse/api/src/services/graphBridge.ts` and call the service helper instead. The bridge query is correct but a service-level helper is cleaner and easier to migrate to ARC-token HTTP later.

---

## OSN Core (`osn/app` + `osn/core`)

- [x] OAuth/OIDC provider (passkey, OTP, magic link, PKCE, JWT) in `@osn/core`
- [x] User registration/login flows
- [x] `osn/app` auth server entry point (port 4000)
- [x] 50 tests: services, routes, lib/crypto, lib/html
- [x] Social graph data model (connections, close friends, blocks) — 124 tests
- [x] Handle system — registration, real-time availability check, email/handle sign-in toggle
- [ ] ARC token verification middleware on internal graph routes (`/graph/internal/*`)
- [ ] Per-app vs global blocking logic (deferred — global blocking across all OSN apps for now)
- [ ] Interest profile selection (onboarding)
- [ ] Third-party app authorization flow

---

## Zap (`zap/app` + `zap/api` + `zap/db`)

OSN's messaging app. Currently a placeholder — `zap/` exists with a
README and is wired into the workspaces glob, but no workspaces have
been scaffolded yet. Stack matches Pulse (Bun, Tauri+Solid, Elysia+Eden,
Drizzle+SQLite, Effect.ts) unless a real reason emerges to diverge.
Signal Protocol lives in `@osn/crypto`, not `zap/`.

### M0 — Scaffold (no behaviour, just the skeleton)

- [ ] `bunx create-tauri-app` for `@zap/app` (iOS target enabled, Solid template)
- [ ] `@zap/api` workspace (Elysia + Eden, mirror `@pulse/api` layout, port TBD)
- [ ] `@zap/db` workspace (Drizzle + SQLite, mirror `@pulse/db` layout)
- [ ] `@zap/app` consumes `@osn/client` + `@osn/ui/auth` for sign-in (re-uses the same `<SignIn>` / `<Register>` from Pulse)
- [ ] Initial test infra (`tests/helpers/db.ts`, `createTestLayer()`) for `@zap/api` and `@zap/db`
- [ ] Add `@zap/app`, `@zap/api`, `@zap/db` to the turbo pipeline (build / check / test)
- [ ] Register `zap-app` and `zap-api` in `service_accounts` (ARC token issuer rows)

### M1 — 1:1 DMs (E2E)

- [ ] Signal Protocol primitives in `@osn/crypto/signal` (X3DH handshake, double ratchet)
- [ ] `@zap/db` schema: `chats`, `chat_members`, `messages`, `device_keys`, `prekey_bundles`
- [ ] `@zap/api` routes: `POST /chats` (create DM), `POST /chats/:id/messages`, `GET /chats/:id/messages`
- [ ] WebSocket transport for live message delivery (`@zap/api`)
- [ ] Push receipt + read receipt model (defer push notifications themselves to M4)
- [ ] `@zap/app` Socials view: chat list + message thread UI
- [ ] Resolve recipients via `@osn/client` (handle → user lookup) + ARC-gated `/graph/internal/connections` to filter out blocked users
- [ ] Test coverage: handshake, ratchet, message ordering, blocked-user enforcement
- [ ] Disappearing messages flag at chat level + per-message TTL sweep

### M2 — Group chats

- [ ] Group session establishment (sender keys or MLS — pick one and document)
- [ ] `@zap/db` schema: `chat_role` (admin/member), `chat_invites`
- [ ] Add/remove members, role transitions, invite links
- [ ] Group-level disappearing-message defaults
- [ ] Event chat linking: when a `@pulse/api` event is created, optionally provision a Zap group chat and stash the chat ID on the event row
- [ ] Show linked event overview inside the chat settings sheet (read from `@pulse/api` via Eden or ARC-gated S2S)
- [ ] Test coverage: group rekeying on member removal, race conditions on simultaneous joins

### M3 — Organisation chats (the differentiator)

- [ ] `organisations` table in `@osn/db` (verified flag, owner user, allowed scopes, public profile)
- [ ] Verification flow (manual review for now; document the criteria)
- [ ] `org_chats` and `org_agents` schemas in `@zap/db` — assignment, queue, status (open/pending/resolved), SLA timestamps
- [ ] Organisation-side dashboard (separate `@zap/app` view, role-gated): inbox, agent assignment, transcript export, analytics
- [ ] Embeddable web widget — small standalone bundle (Vite + Solid) shipped from `@zap/api` static, accepts an OSN handle and opens a conversation under the calling org
- [ ] E-commerce checkout integration: capture OSN handle alongside email at checkout, surface order context to org agents
- [ ] Public REST API for orgs to ingest support context from third-party systems (Zendesk-shaped surface)

### M4 — Locality / government channels

- [ ] Locality opt-in flow in `@zap/app` (permanent home + temporary travel subscriptions with expiry)
- [ ] `localities` and `locality_subscriptions` schemas in `@zap/db`; `locality_org` join to organisations
- [ ] Push channel for verified locality/government broadcasts (one-way; users can ask follow-ups via the org channel)
- [ ] AI-assisted query endpoint scoped to a locality ("nearest relief centre to my location") — defer model choice
- [ ] Privacy: locality stored on device + minimal server-side join; user-resettable per the OSN data principles
- [ ] Test coverage: travel subscription expiry, broadcast fan-out, query authority filtering

### M5 — Polish + AI view + native

- [ ] Themes (token-driven, share `@osn/ui` design tokens once those exist)
- [ ] Stickers + GIFs (third-party provider TBD; needs CSP review)
- [ ] Polls (per-chat, with privacy mode)
- [ ] Easter-egg mini-games (scoped, opt-in)
- [ ] AI view: dedicated tab for model conversations, quarantined from the Socials inbox; user-selectable model
- [ ] Push notifications (APNs first, FCM later — ties to Android deferral)
- [ ] Backup options: encrypted cloud / self-hosted / local-only
- [ ] Device transfer flow (key migration, backup restore)

### Cross-cutting / open questions

- [ ] Signal vs MLS for group chats — Signal sender-keys is simpler; MLS scales better past ~50 members. Decide before M2.
- [ ] Storage backend at scale: SQLite is fine for a single Bun process but messages have very different access patterns to events/users. Revisit when message volume forces it (likely Postgres / Supabase, possibly with an object store for media).
- [ ] Message media (images, video, voice notes) — needs E2E-friendly blob storage. Defer to post-M2.
- [ ] Spam / abuse model for organisation handles — verification gate is M3 but we'll need ongoing review tooling.

---

## Landing (`osn/landing`)

- [x] Astro + Solid scaffolding
- [ ] Design and build landing page content
- [ ] Deploy (Vercel/Cloudflare)

---

## Platform

### Pulse events API (`pulse/api`)

- [x] Elysia setup + Eden client
- [x] Effect.ts trial integration
- [x] Events domain (list, today, get, create, update, delete) — 47 tests
- [ ] Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (currently N individual writes)
- [ ] Eliminate extra `getEvent` round-trips in `createEvent`/`updateEvent` via `RETURNING *`
- [ ] S2S graph access: add `@osn/core` + `@osn/db` deps; use `createGraphService()` read-only for event filtering (`hideBlocked`, `onlyConnections`) — first ARC token consumer
- [ ] OSN/messaging domain modules
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers

### Database (`osn/db`, `pulse/db`)

- [x] Per-app DB packages (osn-db, pulse-db)
- [x] Pulse: events schema, migrations, smoke tests
- [x] OSN Core: users + passkeys schema, migration, smoke tests
- [x] OSN Core: social graph schema (connections, close_friends, blocks)
- [x] OSN Core: `service_accounts` table — `service_id`, `public_key_jwk`, `allowed_scopes` (for ARC token verification)
- [ ] OSN Core: session schema (JWT-based for now; DB storage deferred)
- [ ] Pulse: event series schema
- [ ] Pulse: chat/message schema (via messaging backend)
- [ ] Add indexes on `status` and `category` columns in pulse-db events schema

### Auth Client (`osn/client`)

- [x] Eden client wrapper
- [x] `getSession()` with expiry check
- [x] `AuthProvider` + `handleCallback` for SolidJS
- [x] 10 tests

### Crypto (`osn/crypto`)

- [x] `generateArcKeyPair()` — ES256 keypair generation
- [x] `createArcToken(privateKey, { iss, aud, scope, ttl? })` — signs and returns a short-lived JWT
- [x] `verifyArcToken(token, publicKey)` — verifies signature, expiry, audience, scope
- [x] `resolvePublicKey(iss)` — looks up public key from `service_accounts` table (Effect-based, requires Db)
- [x] In-memory token cache with 30s-before-expiry eviction (`getOrCreateArcToken`)
- [x] Key import/export utilities (`exportKeyToJwk`, `importKeyFromJwk`)
- [ ] JWKS URL fallback in `resolvePublicKey` for third-party apps

### UI Components (`osn/ui`)

- [ ] Design system / tokens
- [ ] Button, Input, Card basics
- [ ] Chat interface (shared between Pulse and Messaging)
- [ ] Event card component
- [ ] Calendar component

### Infrastructure

- [x] Turborepo + Changesets
- [x] Shared TypeScript configs
- [x] CI/CD (GitHub Actions) — lint, format, typecheck, tests, security review
- [x] lefthook pre-commit/pre-push hooks
- [x] oxlint + oxfmt
- [x] Claude Code GitHub integration
- [x] Claude skills: review-security, review-performance, review-tests, prep-pr, review-deps
- [x] UserPromptSubmit hook for tone enforcement
- [x] Changeset Check workflow runs `bunx changeset status` so a `.changeset/*.md` referencing a non-existent workspace name fails the PR — previously such typos blew up the Release workflow on main and blocked all subsequent versioning (e.g. `"pulse"` instead of `"@pulse/app"` in `fix-handle-regex-error-message.md`).

---

## Security Backlog

Address **High** items before any non-local deployment.

### High

- [ ] S-H1 — Rate limit `/register/begin`, `/register/complete`, `/handle/:handle`, and the OTP/magic-link login endpoints. New registration flow has a per-entry attempt cap (max 5 wrong OTPs → wipe) but still no per-IP / per-email throttle, so an attacker can email-bomb arbitrary addresses or spray begin-then-complete cycles. Needs middleware infra; the existing graph rate-limiter is per-user, which doesn't apply to unauthenticated routes.
- [ ] S-H2 — `GET /handle/:handle` no rate limit — handle namespace fully enumerable at HTTP speeds; add 10 req/IP/min limit
- [ ] S-H3 — Open redirect in `/magic/verify`: `redirect_uri` not validated against allowlist — attacker can steal auth codes
- [ ] S-H4 — PKCE check optional at `/token`: silently skipped when `state` absent — make mandatory per RFC 7636. The new registration flow no longer depends on this bypass (it returns tokens directly from `register/complete`), but every other flow that mints an authorization code (`/passkey/login/complete`, `/otp/complete`, `/magic/verify`) is still vulnerable: any leaked code can be redeemed without proof of possession by simply omitting `state`. Drop the `if (state) { … }` conditional in `routes/auth.ts:150-180` so PKCE verification is unconditional on `authorization_code` grants.
- [ ] S-H5 — `/passkey/register/{begin,complete}` legacy unauth'd path: when no `Authorization` header is present, the routes still trust `body.userId` as proof of identity. The new registration flow no longer hits this path (it carries an enrollment token), but the hosted `/authorize` HTML page (`buildAuthorizeHtml`) still does, which means the cross-user passkey enrolment vector is reachable for any user that authenticates through the hosted UI. Migrate the hosted UI to also use enrollment tokens (or just access tokens for already-logged-in flows) and then make the `Authorization` header required on both routes.
- [x] S-H6 — No auth/authorisation middleware on API routes (OWASP A01) — POST/PATCH/DELETE require auth; unauthenticated → 401
- [x] S-H7 — No ownership check on mutating event operations — createdByUserId NOT NULL; 403 on non-owner
- [x] S-H8 — Graph GET endpoints unguarded — all GET handlers wrapped in try/catch; generic "Request failed" on unexpected errors
- [x] S-H9 — `/register/complete` exploited a pre-existing PKCE bypass at `/token` to mint a session — fixed in the registration flow redesign: `register/complete` now issues access + refresh tokens directly and the registration code path never calls `/token`. Underlying `/token` bypass is tracked separately as S-H4.
- [x] S-H10 — TOCTOU between OTP verify and user insert in `completeRegistration` — fixed: insert is attempted directly, the unique constraint is the source of truth, and a losing race no longer burns the pending OTP entry.
- [x] S-H11 — `email.toLowerCase()` was used as the pending-registrations map key but the original-cased value was persisted, allowing two near-duplicate accounts — fixed: the lowercased value is now the canonical form throughout the registration pipeline (the legacy `/register` path is unchanged; tracked as S-M19 below).
- [x] S-H12 — `GET /events/:id` did not gate by `visibility`. `listEvents` filtered private events from discovery but direct ID fetch returned full event details to anyone with the URL (incl. unauthenticated). Fixed in the full-event-view PR via shared `loadVisibleEvent` helper in `pulse/api/src/services/eventAccess.ts` — returns 404 (not 403) to non-authorised viewers to avoid existence disclosure.
- [x] S-H13 — `GET /events/:id/ics` had the same root cause as S-H12 — leaked private event metadata including GEO coordinates as a downloadable file. Fixed via `loadVisibleEvent`.
- [x] S-H14 — `GET /events/:id/comms` had the same root cause as S-H12 — leaked organiser blast bodies (which may contain venue codes, addresses, dress codes). Fixed via `loadVisibleEvent`.
- [x] S-H15 — `GET /events/:id/rsvps?status=invited` leaked the organiser's invite list to anyone (or to any of the organiser's connections for connections-gated events). Invitees never opted in (the public-guest-list override applies only to people who have actually attended). Fixed in `listRsvps`: queries with `status: "invited"` return empty unless the viewer is the event organiser.
- [x] S-H16 — `GET /events/:id/rsvps/counts` leaked existence + activity of private events. Fixed via the shared `loadVisibleEvent` gate.

### Medium

- [ ] S-M1 — `verifyAccessToken` rejects tokens missing `handle` claim — old tokens 401 silently; treat missing `handle` as `null` during transition period
- [ ] S-M2 — In-memory rate limiter resets on restart/deploy — document as known; migrate to shared counter when scaling horizontally
- [ ] S-M3 — No "resend code" button after registration OTP; if SMTP fails, handle/email are claimed with no recovery path. Partly mitigated by the new flow's "refuse to overwrite a non-expired pending entry" policy (the user retries via the existing pending entry, no new email is sent), but a true resend button is still needed.
- [ ] S-M4 — Legacy `POST /register` (unverified email) returns raw `String(catch)` error — can expose Drizzle constraint internals. The new `/register/{begin,complete}` routes already use the `publicError()` mapper from `routes/auth.ts`; extend the same mapper to the legacy endpoint and to all other routes that still use `String(e)`.
- [ ] S-M5 — `displayName` embedded in JWT (1h TTL) — stale after profile update; `createdByName` on events reflects old value until token expires
- [ ] S-M6 — Wildcard CORS on auth server — restrict to known client origins before deployment
- [ ] S-M7 — Login OTP (`/otp/begin` → `/otp/complete`) has no per-entry attempt limit. The new registration `completeRegistration` enforces 5 wrong guesses → wipe; mirror that into `completeOtp`.
- [ ] S-M8 — All auth state in process memory (`otpStore`, `magicStore`, `pkceStore`) — lost on restart, unsafe for multi-process
- [ ] S-M9 — `redirect_uri` at `/token` not matched against value stored in `pkceStore` during `/authorize` (RFC 6749 §4.1.3)
- [ ] S-M10 — `/passkey/register/begin` accepts arbitrary `userId` with no auth check (elevated to S-H5; see High section)
- [ ] S-M11 — Magic-link tokens use `crypto.randomUUID` without additional entropy hardening
- [x] S-M12 — `limit` query param in `listEvents` uncapped — clamped to 1–100 in service layer
- [ ] S-M13 — Photon (Komoot) geocoding: keystrokes sent to third-party with no user notice — add consent UI or proxy
- [ ] S-M14 — Pulse `REDIRECT_URI` falls back to `window.location.origin` — validate allowed redirect URIs server-side; tracked as S-H3
- [x] S-M15 — `is-blocked` route leaked whether target had blocked caller — route now uses `isBlocked(caller, target)` only
- [x] S-M16 — No rate limiting on graph write endpoints — module-level fixed-window limiter added (60/user/min)
- [x] S-M17 — Raw DB/Effect errors surfaced in graph responses — `safeError()` helper; only `GraphError`/`NotFoundError` messages exposed
- [x] S-M18 — No input validation on `:handle` route param in graph routes — TypeBox `HandleParam` with regex + length bounds added
- [ ] S-M19 — Legacy `/register` does not lowercase emails — two users can register `Alice@example.com` and `alice@example.com` as distinct accounts. New email-verified path normalises; lift the same normalisation into `registerUser`, `findUserByEmail`, OTP login, and magic-link login. Add a DB-level unique index on `lower(email)` to enforce.
- [ ] S-M20 — Refresh tokens stored in `localStorage` via `OsnAuth.setSession` (default `Storage` adapter is `localStorage`). XSS in the Pulse webview = permanent account takeover. For Tauri, swap in a keychain-backed adapter (`tauri-plugin-stronghold` or an OS-encrypted store); for web targets, prefer HttpOnly cookies issued by the auth server.
- [ ] S-M21 — `/register/begin` differential timing oracle on the silent no-op branch — when an email is already taken, the route skips the `sendEmail` call, so the response is consistently faster than the legitimate path. Add a synthetic delay or perform a dummy hash to flatten timing if/when this becomes exploitable.
- [x] S-M22 — `console.log` of OTP in dev fallback unconditionally exposed credentials in any environment without `sendEmail` set — fixed in the new registration flow: gated on `NODE_ENV !== "production"`. Same fix should be applied to the login OTP path (`beginOtp`).
- [x] S-M23 — `pendingRegistrations` Map grew unboundedly with no eviction (P-W1 / S-M2 of the security review) — fixed: capped at 10 000 entries, swept on every insert, and refuses to overwrite a non-expired entry to prevent griefing.
- [x] S-M24 — Biased modulo OTP generation (`buf[0] % 900_000` over a 32-bit draw) — fixed in the new registration flow via rejection sampling in `genOtpCode()`. Login OTP path still uses the biased version; lift the helper.
- [x] S-M25 — Non-constant-time OTP comparison via `===` — fixed in the new registration flow via `timingSafeEqualString()`. Login OTP path still uses `!==`; lift the helper.
- [x] S-M26 — Differential error responses on `/register/begin` (`Email already registered` vs `Handle already taken` vs `sent: true`) leaked which accounts exist — fixed: the route now always returns `{ sent: true }` regardless of conflict status. The handle availability check via `/handle/:handle` remains the appropriate channel for that question and can be rate-limited independently.
- [x] S-M27 — `close_friends` per-row visibility filter in `pulse/api/src/services/rsvps.ts` had inverted directionality: it checked the *viewer's* close-friends list, allowing a stalker who unilaterally added a target as a close friend to see the target's gated RSVPs. Fixed in the full-event-view PR via a new `getCloseFriendsOf(viewerId, attendeeIds[])` bridge query that returns the subset of attendees who have marked the *viewer* as a close friend. The attendee owns the privacy decision; the filter now reflects that.
- [x] S-M28 — `getConnectionIds` / `getCloseFriendIds` in `pulse/api/src/services/graphBridge.ts` silently capped membership sets at 100, causing the visibility filter to under-permit users with larger graphs. Fixed in the full-event-view PR by raising the cap to `MAX_EVENT_GUESTS` (1000) — the platform-wide hard cap on event guest count, documented in `pulse/api/src/lib/limits.ts` and the package README. Resolves both this finding and P-W13 (same root cause).
- [x] S-M29 — No `maxLength` on `title` / `description` / `location` / `venue` / `category` in `InsertEventSchema` allowed an authenticated user to POST a 10MB description and bloat every discovery response. Fixed in the full-event-view PR with explicit caps (title 200, description 5000, location/venue 500, category 100) on both Insert and Update schemas.

### Low

- [ ] S-L1 — Seed data uses reserved handle `"me"` — inserted via Drizzle bypassing service layer; reveals reservation is not DB-enforced
- [ ] S-L2 — `Effect.orDie` in `requireAuth` swallows auth errors as defects — replace with `Effect.either` + explicit 401
- [ ] S-L3 — Tauri CSP is `null` — when tightened, allowlist `photon.komoot.io`, `maps.google.com`, `www.google.com`
- [ ] S-L4 — `createdByAvatar` always null — no avatar claim in JWT; populate from user profile once profiles exist
- [x] S-L5 — `getSession()` returned expired tokens — fixed
- [x] S-L6 — OTP used `Math.random()` — replaced with `crypto.getRandomValues`
- [ ] S-L7 — `jwtSecret` falls back to `"dev-secret"` — throw at startup in production
- [ ] S-L8 — OTP codes and magic link URLs logged to stdout — guard with `NODE_ENV` check
- [ ] S-L9 — `imageUrl` allows `data:` URIs — add CSP `img-src` header
- [ ] S-L10 — Sign-in page loads `@simplewebauthn/browser` from unpkg CDN without SRI hash
- [ ] S-L11 — Failed OAuth callback leaves PKCE verifier in `localStorage` — clear on state mismatch
- [ ] S-L12 — `REDIRECT_URI` derived from `window.location.origin` at runtime — prefer explicit env var
- [ ] S-L13 — PKCE `state` not validated against a stored nonce
- [x] S-L20 — `sendBlast` in `pulse/api/src/services/comms.ts` `console.log`ged the first 60 chars of every blast body to stdout in non-test envs. Blast bodies frequently contain venue codes / addresses / private details. Fixed in the full-event-view PR by removing the log entirely — tests cover the contract directly via the returned `blasts` array.
- [x] S-L21 — `serializeRsvp` in `pulse/api/src/routes/events.ts` returned `invitedByUserId` to all viewers, revealing which co-host invited each attendee on multi-organiser events. Fixed in the full-event-view PR by passing an `isOrganiser` flag through the route layer; non-organiser viewers now receive `invitedByUserId: null`.
- [ ] S-L22 — `listRsvps` counts privacy-filtered rows toward `limit`, providing a weak side-channel oracle: an attacker can vary `limit` and infer how many privacy-filtered rows exist between visible ones. Low exploitability (requires many probes; only reveals counts of an opaque population). Fix would loop until `limit` visible rows are collected. Deferred — folded into a future "stable pagination" pass on `listRsvps`.
- [ ] S-L14 — `assertion: t.Any()` on passkey register/login routes — add TypeBox shape validation for top-level WebAuthn fields
- [ ] S-L15 — No reserved-handle blocklist in DB — enforced in app layer only; consider DB-level check constraint
- [x] S-L16 — `EventList` `console.error` logs raw server error objects — guarded with `import.meta.env.DEV`
- [x] S-L17 — `displayName` returned as `undefined` in graph list responses — normalised to `null` via `userProjection()`
- [ ] S-L18 — Graph rate-limit store (`rateLimitStore`) never evicts expired windows — add periodic sweep
- [ ] S-L19 — `jwtSecret` falls back to `"dev-secret"` in graph auth — already tracked as S-L7

---

## Performance Backlog

### Critical

- [x] P-C1 — `filterByAttendeePrivacy` in `pulse/api/src/services/rsvps.ts` had an N+1 lookup against `pulse_users` (the comment claimed "batch-fetch" but the implementation did `for (id of attendeeIds) yield* getAttendanceVisibility(id)`), firing up to 200 extra queries per `listRsvps` call on busy events. Fixed in the full-event-view PR by adding `getAttendanceVisibilityBatch(userIds[])` to `pulseUsers.ts` (single `WHERE userId IN (...)` query, defaults missing keys to `connections`) and replacing the for-loop with a single call.

### Warning

- [ ] P-W1 — `rateLimitStore` in graph routes grows without bound — expired entries never evicted; add `setInterval` sweep
- [ ] P-W2 — `resolvePublicKey` hits DB on every scoped call despite warm cache — cache `CryptoKey` + `allowedScopes` together
- [ ] P-W3 — `sendConnectionRequest` makes two sequential independent DB reads — use `Effect.all` with `concurrency: "unbounded"`
- [ ] P-W4 — Auth Maps (`otpStore`, `magicStore`, `pkceStore`) never evict expired entries — add periodic sweep. The new `pendingRegistrations` map already uses `sweepExpired()` on insert; lift the helper into the other stores.
- [ ] P-W10 — `RegistrationClient.checkHandle` has no `AbortController` — debounced bursts of typing can leave multiple in-flight `GET /handle/:handle` requests racing each other; results are guarded against display races but the network requests still hit the DB. Plumb an `AbortSignal` through and abort the previous request when a new one is scheduled.
- [ ] P-W11 — `beginRegistration` and the legacy `registerUser` issue two parallel `findUserByEmail` + `findUserByHandle` queries instead of a single `WHERE email = ? OR handle = ?` — doubles the DB latency component on a hot signup path. Add a `findUserByEmailOrHandle` helper.
- [ ] P-W5 — Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (N individual writes today)
- [x] P-W6 — N+1 queries in graph list functions — replaced with `inArray` batch fetches
- [x] P-W7 — `eitherBlocked` made two sequential `isBlocked` calls — collapsed to single OR query
- [x] P-W8 — `blockUser` used SELECT-then-DELETE pattern — replaced with direct `DELETE WHERE OR`
- [x] P-W9 — Eliminate extra `getEvent` round-trips in `updateEvent` — returns in-memory merged result
- [x] P-W12 — `listEvents` in `pulse/api/src/services/events.ts` clamped with `LIMIT` *before* the in-JS visibility filter, yielding unstable page sizes (the DB returned 20 rows but the JS filter could drop several private ones, leaving the client with fewer than requested) AND defeating the `events_visibility_idx` index. Fixed in the full-event-view PR by pushing the visibility filter into the SQL `WHERE` clause via `or(eq(events.visibility, "public"), eq(events.createdByUserId, viewerId))`.
- [x] P-W13 — Same root cause as S-M28: `getConnectionIds` / `getCloseFriendIds` capped at 100, silently truncating membership sets. Fixed jointly with S-M28 by raising the bound to `MAX_EVENT_GUESTS`.
- [x] P-W14 — `MapPreview` and Leaflet (~150KB + CSS) shipped on every Pulse cold start because the route, the page component, and Leaflet itself were all static imports from `App.tsx`. Fixed in the full-event-view PR with two complementary changes: (1) `EventDetailPage` and `SettingsPage` are now route-level `lazy()`-loaded in `App.tsx`, and (2) `MapPreview` itself dynamic-imports Leaflet inside `onMount` so events without coordinates never pay for the chunk at all.

### Info

- [ ] P-I1 — `evictExpiredTokens` in `arc.ts` iterates full cache on every `getOrCreateArcToken` call — throttle or remove; `MAX_CACHE_SIZE` is sufficient
- [ ] P-I2 — `new TextEncoder()` allocated per JWT sign/verify call — cache encoded secret or import `CryptoKey` once
- [ ] P-I3 — `new TextEncoder()` allocated per `verifyPkceChallenge` call — move to module scope
- [ ] P-I4 — `AuthProvider` reconstructs Effect `Layer` on every render — wrap with `createMemo`
- [ ] P-I5 — `completePasskeyLogin` calls `findUserByEmail` redundantly — `pk.userId` already on passkey row
- [ ] P-I6 — Duplicate index on `users.email` — `unique()` already creates one implicitly in SQLite
- [ ] P-I7 — Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *`
- [ ] P-I8 — `resolveHandle` re-fetches user from DB when handler already has the User row
- [ ] P-I9 — Graph list endpoints load entire result set before slicing — add DB-level `LIMIT`/`OFFSET` when pagination is user-facing
- [x] P-I10 — `Register.tsx` used `createEffect` to auto-skip the passkey step when WebAuthn was unsupported — fixed: skip is now imperative, called directly from `submitOtp` after the step transition. Removes the re-fire surface area and the `!busy()` infinite-loop guard.
- [x] P-I11 — `Register.tsx` wrapped `detailsValid` in `createMemo` for a 3-line boolean expression — fixed: inlined as a plain accessor function. Solid's reactivity already re-runs JSX accessors fine-grainedly; the memo node was pure overhead.
- [x] P-I12 — `Register.tsx` reallocated the `RegistrationClient` (and its closures) on every component mount — fixed: hoisted to module scope.
- [ ] P-I13 — `upsertRsvp` calls `ensurePulseUser(userId)` even on the update branch (the row must already exist for the user to have an RSVP). Folded into the full-event-view PR's RSVP rewrite — `ensurePulseUser` now only runs on the insert branch, saving one round-trip per RSVP update. Tracking here for posterity. **Already fixed; this entry is documentation.**
- [ ] P-I14 — `GET /events/:id/ics` in `pulse/api/src/routes/events.ts` has no `Cache-Control` / `ETag` headers despite the response being a pure function of `event.id` + `event.updatedAt`. Calendar clients re-poll the URL on a schedule and would benefit from `If-None-Match` revalidation. Deferred — quality-of-life, not a hot path.
- [ ] P-I15 — `rsvpCounts` in `pulse/api/src/services/rsvps.ts` calls `loadEvent(eventId)` purely to produce a 404 signal. The route already gates the event via `loadVisibleEvent` upstream, so the second `loadEvent` is redundant on every counts request. Deferred — minor cleanup, the defensive 404 is cheap.

---

## Deferred Decisions

| Decision | Context | Revisit When |
|----------|---------|--------------|
| Social media platform name | Need a catchy name | Before starting Phase 3 |
| Signal vs MLS for Zap group chats | Sender-keys is simpler; MLS scales past ~50 members | Before Zap M2 |
| Zap media storage (images / voice / video) | Needs E2E-friendly blob storage; SQLite-only won't cut it | When Zap M2 lands |
| Effect.ts adoption | Trial underway in `pulse/api` | After more service coverage |
| Supabase migration | Currently SQLite | When scaling needed |
| Android support | iOS priority | Phase 3 |
| Self-hosting | Enterprise use case | Phase 3 |
| Payment handling | Deferred for Pulse ticketing | After core Pulse features |
| Two-way calendar sync | Currently one-way (Pulse → external) | Phase 2 |
| Community event-ended reporting | 15–20 attendees auto-finish; host notified | When attendee/messaging features land |
| Max event duration | Prompt user when creating events without endTime | When Pulse event creation UI is built |
| S2S scaling: HTTP graph API | Current: direct package import (`createGraphService()`). Migrate to HTTP `/graph/internal/*` + ARC tokens when scaling horizontally. | When multi-process or multi-machine deployment needed |
| Per-app blocking | Blocks are global across all OSN apps. Per-app scope deferred. | When Messaging or a third-party app needs independent block lists |
| Tauri passkey support on iOS | Tauri webview does not expose WebAuthn natively — `pulse/app` registration flow (rendered by `@osn/ui/auth/Register`) feature-detects via `browserSupportsWebAuthn()` and auto-skips the passkey step on unsupported environments. Options when we ship mobile: (a) adopt [`tauri-plugin-webauthn`](https://github.com/Profiidev/tauri-plugin-webauthn) (third-party, audit first), (b) write our own thin Tauri plugin wrapping `ASAuthorizationPlatformPublicKeyCredentialProvider`, (c) wait for upstream — track [tauri#7926](https://github.com/tauri-apps/tauri/issues/7926). | When iOS build of Pulse is ready for sign-in |

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
