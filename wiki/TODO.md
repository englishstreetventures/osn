# OSN Project TODO

Progress tracking and deferred decisions. Completed items move to `[[changelog/]]`. For the full spec see README.md. For code patterns see CLAUDE.md. For detailed system docs see [[index]].

## Up Next

Now **deployed on `cireweddings.com`** (Cloudflare Free tier — see [[production-deploy]], [[free-tier-limits]], [[changelog/completed-features]] "Production launch" 2026-06-18). Post-deploy priorities:

- [ ] **Cloudflare Turnstile — live on osn-api, still off on cire-api.** Widget created and the `PUBLIC_TURNSTILE_SITEKEY` Variable set (#160); `TURNSTILE_SECRET_KEY` **is set on osn-api-production**, so register/login gates bite. Residual work: re-set the cire-api secret — deleted 2026-07-20 after a mismatched value rejected every guest claim, so `/api/claim` is ungated today. (No preview hostname to list any more: the osn-social preview workflow was removed 2026-07-27, so `musubi.social` is the only form-rendering origin needing a **Domains** entry.) **Fixed 2026-07-27:** the identity move left `@osn/social` with no sitekey, so every musubi.social sign-in returned `400 turnstile_failed` — see the sub-item under the identity move below. See [[turnstile]], [[production-deploy]] §3.4.
- [x] **`OSN_PAIRWISE_SALT` is set on `osn-api-production`** — the fail-closed boot check no longer throws (`/health` is 200 again). PR #315's auto-deploy shipped that check before the salt existed, and every route 503'd from 2026-07-24 04:21 UTC until the `Set OSN_PAIRWISE_SALT` workflow ran. `wrangler deploy` reported success throughout, because the throw happens at request time — hence the preflight item below. **Never rotate the salt**: it is the HMAC key behind every pairwise `sub`, and changing it makes every OIDC client see its users as strangers. See [[oidc-provider]], [[production-deploy]].
- [ ] **Deploy preflight for required secrets** — `deploy.yml`'s `deploy-osn-api` job runs `wrangler deploy --env production` with no check that the secrets `build-deps.ts` demands actually exist. That is what let the outage above ship green. A `wrangler secret list` gate before deploy would catch the next required-secret addition. **Widen it to stale values, not just missing ones:** on 2026-07-27 `cire-api-production`'s `OSN_API_URL` secret still named `id.cireweddings.com` after the issuer moved, because a secret is invisible to a repo-wide grep — every cire→osn ARC call failed until it was re-set. A secret holding an origin should be reachable at deploy time. See [[production-deploy]], [[musubi-identity-migration]].
- [ ] **Finish the `musubi.social` identity move — cire sign-in is restored on `feat/cire-oidc-login`, live on merge.** The flip shipped 2026-07-27: `osn-api` on `id.musubi.social`, `@osn/social` (sign-in + consent) on the **apex `musubi.social`**, `OSN_RP_ID = musubi.social`. It went **ahead of** the cire OIDC conversion on purpose, so every passkey enrolled under `cireweddings.com` died (recovery codes are the only way in) and organiser + vendor + guest-linking sign-in broke — wrong RP ID from a cireweddings.com origin. Bearer-token verification was never affected. **State:**
  - **PR C — merged 2026-07-28 (#322).** cire is registered as the first-party OIDC client `cid_cire` (row seeded by hand in prod D1, see [[production-deploy]] §3.5), and organiser, vendor and web now redirect to `id.musubi.social/authorize` with PKCE S256; cire-api exchanges the code server-side and mints its own `cire_org_session` cookie. See [[cire-auth]].
  - **Deploy gate on merge:** `CIRE_OIDC_CLIENT_SECRET` must be set on `cire-api-production`, else `/api/auth/oidc/*` answers 503 `sign_in_unavailable`. (There is no longer a preview Worker to set it on — see the preview teardown below.)
  - **Dashboard steps — both done 2026-07-27**: the apex `musubi.social` is attached to the `osn-social` Pages project, and `musubi.social` is on the Turnstile widget's domain list. (`id.musubi.social` needs no Turnstile entry — only form-rendering hostnames do.)
  - **[x] Turnstile client half followed the ceremonies (fixed 2026-07-27).** The domain-list entry above was only half the job: osn-api's `TURNSTILE_SECRET_KEY` has been set since #160, and the sitekey used to reach the ceremony forms through the **cire/organiser** Astro build. Moving the ceremonies to `@osn/social` — and stripping them from organiser in the OIDC swap — left the `deploy-osn-social` job passing no sitekey and `Sidebar` / `AuthorizeSignIn` passing no `turnstileSiteKey`, so every typed-identifier sign-in and registration on the apex returned `400 turnstile_failed`. Wired `VITE_TURNSTILE_SITEKEY` through both osn-social builds into all three call sites, guarded by `osn/social/tests/components/turnstile-wiring.test.tsx`. See [[turnstile]].
  - **Re-enrolment**: recovery-code login → OTP step-up (`purpose: passkey_register`) → enroll a passkey under the new RP ID → `POST /recovery/generate` for fresh codes. **Still outstanding for the one live account** — nine of ten codes remain and all predate the flip.

  See [[musubi-identity-migration]], [[production-deploy]] §5.4.
- [ ] **Free Cloudflare dashboard hardening** (manual — wrangler cannot do this) — confirm the free WAF Managed Ruleset, add a custom rule blocking public `/internal/*` + `/graph/internal/*`, enable Page Shield on the guest site, confirm L7 DDoS. See [[free-tier-limits]] "Cloudflare security hardening".
- [ ] **Re-enable email later** — provision Cloudflare Email Service (`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_EMAIL_API_TOKEN` + `OSN_EMAIL_FROM`), watch `osn.email.send.attempts{outcome="sent"}`, then **remove** `OSN_EMAIL_OPTIONAL=true` from osn-api `[vars]`. Restores OTP step-up everywhere (incl. cire organiser, currently passkey-only). See [[email]], [[production-deploy]] §1.1.
- [ ] **Optional Google Maps key** — set the Maps Embed key so cire location previews render the real map instead of the CSS-card fallback (#146; key-optional today). See [[cire]].
- [ ] **Provision Grafana Cloud + wire `OTEL_EXPORTER_OTLP_ENDPOINT` + headers**; build first dashboards (HTTP RED, auth funnel, ARC verification, events CRUD). OTel export is **deferred on workerd** — for now the deployed Workers ship to Cloudflare Workers Logs. See [[observability-setup]], [[observability/overview]].
- _C-H1 (account export) and C-H8 (registration age gate) shipped 2026-07-07 — pruned from Up Next; see `[[compliance/dsar]]` / `[[compliance/coppa]]`._

---

## Auth Audit Remediation (2026-06)

**Status: W1–W7 landed on `claude/stoic-davinci-9v8eap` (PR #116) and reconciled with `main` (#118 shared `appRuntime`, #119 Zap/Pulse Cloudflare Workers).** Every workstream checkbox below is now ticked. The review of the remediation PR itself found three must-fix findings (S-H1 zap-IP, P-W1 zap-consent, S-M1 osn-recovery-CAS — all **fixed** in this PR, see Security/Performance Backlog). It also found follow-on cire/low findings, which stay open in the Security Backlog. On final merge, move this whole section to `[[changelog/completed-features]]`.

Cross-app authentication audit (OSN core, Pulse, Zap, Cire, shared crypto/auth). The findings sit in parallel workstreams **W1–W7**, split to minimise file overlap so agents can work on them at the same time. Each item carries `file:line` + the fix + severity. Where a finding is already tracked, the item points at the existing Security Backlog ID (don't double-track — close it there when the workstream lands).

**Sequencing for parallel agents:**
- **W3 (shared rate-limit) should land first** — W4 and W5's per-IP limiter work both consume the same `getClientIp`.
- **W6-O1 pairs with W7-X2** (issuer + clock-skew must change on signer and verifier together).
- W1 (Zap token model) and W5-C1 (Cire claim code) are the only *exploitable* items — everything else is hardening. Do them first.

### W1 — Zap token model (Critical) — `zap/api`

- [x] AUDIT-Z1 — **Replace hand-rolled HS256 shared-secret verification with `@shared/osn-auth-client`.** `zap/api/src/routes/chats.ts:23-37` verifies bearer tokens with a symmetric `OSN_JWT_SECRET` (default `"dev-secret-change-in-prod"`) and trusts `sub`/`profileId` with no audience or algorithm pin — the verifier holds signing material, so anyone with the secret can forge a token for any `profileId`, and it cannot validate real OSN ES256 tokens. Add the `@shared/osn-auth-client` dep, swap to `extractClaims(authHeader, OSN_JWKS_URL, { audience: "osn-access" })`, delete `OSN_JWT_SECRET` + the HS256 path. Closes **S-L1 (zap)** (algorithm allowlist) and the missing-`aud` gap in one change — see [[rate-limiting]], CLAUDE.md `@shared/osn-auth-client`.
- [x] AUDIT-Z2 — Validate `sub` shape (e.g. `usr_` prefix) post-verify before writing `created_by_profile_id` / `sender_profile_id` (`zap/api/src/routes/chats.ts:31-33`). Defence-in-depth once Z1 lands.

### W2 — Zap authorization & consent (High/Med) — `zap/api/src/services`

- [x] AUDIT-Z3 — `createChat` trusts `memberProfileIds` (up to 500) with no relationship/consent check (`zap/api/src/services/chats.ts:143-159`) → forced-add / messaging spam. Gate added members on an OSN social-graph relationship (ARC S2S) or invite-accept; enforce DM = exactly 2 members; wire the unused `blocked` denial metric (`zap/api/src/metrics.ts:69`).
- [x] AUDIT-Z4 — `addMember` is admin-gated but performs no target-consent check (`zap/api/src/services/chats.ts:193-246`). Same consent/graph gate as Z3.
- [x] AUDIT-Z5 — `removeMember` can remove the last admin, orphaning the chat (`zap/api/src/services/chats.ts:248-285`). Add a "cannot remove last admin" invariant. Closes **S-L3 (zap)**.
- [x] AUDIT-Z6 — Cursor pagination uses a foreign/unknown cursor id verbatim and returns page 1 on a bad cursor (`zap/api/src/services/messages.ts:128-140`) — minor cross-chat leak + confusing contract. Scope the cursor lookup to `chatId`; reject unknown cursors with a validation error.
- [x] AUDIT-Z7 — No ARC S2S trust boundary exists (`zap/` has no `@shared/crypto` dep). Plan an ARC-verified internal surface (e.g. `POST /internal/chats`) on a separate middleware from the user-token routes (mirror cire) before M2 wires Pulse→Zap event-chat provisioning. Relates to **S-M3 (zap)**.
- Note: existing **S-M1/S-M2/S-M4/S-M5/S-M6 (zap)** (rate limiting, CORS, atomic cross-DB write, event-type check, UUID width) also belong to this workstream.

### W3 — Shared rate-limit IP hardening (High) — `shared/rate-limit` ⚠ land first

- [x] AUDIT-S1 — `getClientIp` trusts the first `X-Forwarded-For` hop (spoofable → per-IP limit bypass) and collapses header-less callers into one shared `"unknown"` bucket (one abuser DoSes everyone) (`shared/rate-limit/src/index.ts:85-89`). Add a `trustProxy`/trusted-hop option; resolve from the trusted proxy hop / socket peer (or `cf-connecting-ip` on Workers); fail closed when unresolvable. Closes **S-M34** and **S-L2 (share-attribution)**; unblocks W4/W5 limiter work.

### W4 — Pulse rate-limiting, CORS & exposure (Med) — `pulse/api`

- [x] AUDIT-P1 — Authenticated write endpoints have no rate limiting — event create/update, RSVP, bulk invite, comms blast (`pulse/api/src/routes/events.ts:363,420,663,793,907`), plus `series.ts` and `closeFriends.ts`. Add per-user (`claims.profileId`) fail-closed limiters. Subsumes **S-L1 (series)** and **S-L1 (pulse-close-friends)**.
- [x] AUDIT-P2 — Rate limiters are instantiated with in-memory backends and never wired to Redis despite the injection seam (`pulse/api/src/index.ts:28-35`) → per-process limits that reset on deploy. Add a composition root that builds Redis-backed limiters when `REDIS_URL` is set.
- [x] AUDIT-P3 — Restrict bare `cors()` to known app origins (`pulse/api/src/index.ts:24`). Closes **S-L2 (auth)**.
- [x] AUDIT-P4 — Unauthenticated `POST /events/:id/exposure` accepts a client-supplied `source` and bumps counters with no throttle/replay protection (`pulse/api/src/routes/share.ts:44-71`). Add a per-IP limit (after W3); consider an HMAC'd share token in the `?source=` link. Relates to **S-L2 (share-attribution)**.
- [x] AUDIT-P5 — Any viewer who can see the event also sees the attendee list (`pulse/api/src/routes/events.ts:312-340`) — friends-visibility events let any organiser-friend enumerate every attendee. Add a `canViewAttendees` policy (organiser/co-hosts) or return counts to non-organisers — see [[event-access]].

### W5 — Cire claim-code & guest sessions (High) — `cire/api`

- [x] AUDIT-C1 — **Claim code is ~32-bit, single-factor, throttled only per-isolate.** `publicId` = guessable `SURNAME-` prefix + `crypto.randomUUID().slice(0,8)` (`cire/api/src/services/import.ts:43-51`); it's the sole guest credential and the only throttle is an in-memory `createRateLimiter` that on Cloudflare Workers is per-isolate, not global (`cire/api/src/app.ts:20`, no KV/DO binding in `wrangler.toml`). Raise the suffix to ≥64-bit `getRandomValues` base32, drop the surname from the security-bearing portion, and move the limiter to a shared backend (CF KV / Durable Object / Rate-Limiting binding). **Also correct `cire/wiki/todo/security.md`, which wrongly states the claim limiter is "KV-backed".** _Shipped as: `secure` code style (longer `randomHash`, grouped) is the default in `cire/api/src/services/family-code.ts`, and the limiters run on native Workers `type = "ratelimit"` bindings (`cire/api/wrangler.toml`). The opt-in `simple` style keeps a ~40-bit suffix as an accepted product decision — see **S-M3 (cire)**._
- [x] AUDIT-C2 — `sessionService.revokeAllForFamily` is dead code and there is no claim-code rotation path (`cire/api/src/services/session.ts:128`). Add an organiser "regenerate family code" op that updates `families.publicId` + calls `revokeAllForFamily(familyId)` in one transaction, so a leaked code can be rotated and its ≤30-day sessions evicted.
- [x] AUDIT-C3 — Confirm guest session expiry is enforced on the read path; add `and(eq(tokenHash,…), gt(expiresAt, now()))` to the lookup if absent (`cire/api/src/services/guestSession.ts`).
- [x] AUDIT-C4 — On Workers, key the limiter strictly on `cf-connecting-ip` and fail closed when absent (`cire/api/src/lib/client-ip.ts`). Folds into W3.
- [x] AUDIT-C5 — Add Origin-header validation on state-changing routes (`POST /api/claim`, `/api/rsvp`); today only `SameSite=Lax` defends CSRF. Closes **S-L3 (cire)** — mirror `osn/api/src/lib/origin-guard.ts`.
- [x] AUDIT-C6 (low) — Rotate the guest session token on `POST /api/account/link` (auth-state transition → fixation defence) (`cire/api/src/routes/account.ts`).

### W6 — OSN core hardening (Med/Low) — `osn/api`

- [x] AUDIT-O1 — Set `iss` and add `clockTolerance` to JWT sign/verify (`osn/api/src/services/auth.ts:350-366,1601-1629,2846-2918`). Defence-in-depth + fewer spurious cross-host 401s on the 5-min-TTL refresh path. **Pair with W7-X2.**
- [x] AUDIT-O2 — Recovery-code login has only a per-IP limiter, no per-account lockout (`osn/api/src/services/auth.ts:2641-2750`). Add a per-account failed-attempt counter + temporary lockout + security-event, mirroring the OTP path (`MAX_OTP_ATTEMPTS`).
- [x] AUDIT-O3 — Multi-pod gap: WebAuthn challenge / OTP / pending-registration / pending-email-change / CDL stores and the per-account rate caps are process-local `Map`s (`osn/api/src/services/auth.ts` ~233-657), so begin/complete ceremonies break across pods and the security rate caps degrade to `N×limit`. Give them the injectable-Redis treatment already applied to the jti/rotation stores, or document the single-pod constraint + pin sticky routing.
- [x] AUDIT-O4 — Passkey-registration "invalidate other sessions" (H1) silently no-ops when the session cookie is absent (`osn/api/src/services/auth.ts:1849-1851`); mirror `deletePasskey`'s cookieless branch which invalidates all account sessions.
- [x] AUDIT-O5 (low) — Optional: bind step-up tokens to the issuing session/access-token (`sid`/`cnf` claim) for the most destructive purposes; randomise the enumeration-probe `accountId` so the burn-in predicate isn't a cacheable constant (`osn/api/src/services/auth.ts:2807-2918,1941-1947`).

### W7 — Shared crypto / osn-auth-client (Med/Low) — `shared/crypto`, `shared/osn-auth-client`

- [x] AUDIT-X1 — Add an optional `expectedIssuer` param to `verifyArcToken` and thread it into `jwtVerify`'s `issuer` option (`shared/crypto/src/arc.ts:96-143`); have both ARC middlewares supply it. Today cross-issuer safety is only an emergent property of every caller binding kid→issuer — give the primitive its own defence — see [[arc-tokens]].
- [x] AUDIT-X2 — Add `iss` + `clockTolerance` to access-token verification (`shared/osn-auth-client/src/verify.ts:65`). **Pairs with W6-O1.**
- [x] AUDIT-X3 — ARC token cache key omits `ttl` and uses un-normalised scope (`shared/crypto/src/arc.ts:344-360`) → a caller can receive a shorter-lived cached token than it requested, plus cache fragmentation. Include `ttl` in the key and normalise scope before keying.
- [x] AUDIT-X4 — Document the ≤5-min cross-process ARC public-key revocation window (`shared/crypto/src/arc.ts:154-164`); consider a shorter cache TTL or a pub/sub eviction signal in multi-instance deploys — see [[arc-tokens]].
- [x] AUDIT-X5 (low) — Guard the in-memory Redis client `eval` so a future non-rate-limit Lua script can't silently get rate-limit semantics in dev/test (`shared/redis/src/client.ts:176-193`).

### Verified sound (no action)

The review found these sound: the token-verification core (audience enforced inside the single `jwtVerify` pass, ES256/`alg` pinning, alg:none + HS/RS confusion structurally blocked, JWKS amplification defences); OSN session rotation + family-revocation + cookie-only refresh; Cire two-auth separation + guest tenant-scoping + additive `/account/link`; and Pulse single-source-of-truth visibility with no IDOR. The items above are hardening, except **W1** and **W5-C1**, which are exploitable.

---

## Pulse (`pulse/app` + `pulse/api` + `pulse/db`)

- [x] "What's on today" default view — unified into the discovery feed on `ExplorePage`; default view is `from = now` with the chip rail + more-filters drawer layered on top
- [x] Prompt for max event duration when creating events without an endTime — duration presets + `maybe_finished` status at 8h, auto-close at 12h, 48h defence-in-depth cap on explicit endTimes (moved to `[[changelog/completed-features]]`)
- [x] Event discovery (location, category, datetime, friends, price) — `GET /events/discover` with cursor pagination; bbox + haversine for radius; friends branch unions organiser ∈ connections and RSVP ∈ connections (positive engagement only — `going` / `interested`) and respects `attendanceVisibility=no_one`; per-IP rate limit; interests deferred until the onboarding for Pulse interest profiles lands. See `[[event-access]]` for the shared visibility-filter helper consumed by `listEvents` and `discoverEvents`.
- [x] **Pulse new-user onboarding flow** — six-step `/welcome` flow with themed coral illustrations (welcome rings, editorial map, interest constellation, location pin drop, notifications ember, finish date stamp). Account-keyed via new `pulse_account_onboarding` table + `pulse_profile_accounts` mapping cache + `GET /graph/internal/profile-account` ARC endpoint (preserves the multi-account privacy invariant in `[[identity-model]]`). Captures interests (≤8), `notifications_perm`/`location_perm` outcomes, and reminder opt-in. Idempotent `POST /me/onboarding/complete`. Server-side first-run gate redirects to `/welcome`. See `[[pulse-onboarding]]`. (Move to `[[changelog/completed-features]]` on merge.)
- [x] **Pulse calendar agenda page** — `/calendar` route in `@pulse/app` rendering a vertical-timeline agenda (continuous left rail with per-day dated markers; events listed to the right). Lists events the viewer is hosting OR has RSVP'd Going/Maybe to; "Maybe" entries surface an inline reminder to confirm (I'm going) or drop (Can't make it). Backed by a new auth-gated `GET /events/calendar` endpoint + `listMyCalendarEvents` service (UNION-of-two-arms shape so cost scales with per-user data, not global event volume — see P-W1 fix below). Also a full end-to-end rename of the RSVP status value `interested` → `maybe` (DB enum value, API wire value, metrics, UI; no legacy alias). New `pulse.calendar.events.fetched` counter + `pulse.calendar.list_mine` span. (Move to `[[changelog/completed-features]]` on merge.)
- [ ] Wire captured interests into the discovery feed — add a "For you" chip to `ExplorePage` that filters/boosts events by the account's onboarding interests (data lives in `pulse_account_onboarding.interests` — see `[[pulse-onboarding]]`)
- [ ] Pulse user preferred currency — add a currency field to `pulse_users`, drive the discovery drawer's price filter from it (today the client uses a USD default)
- [ ] Discovery v2 — AI prompt filter surfaced after extended scrolling, server-side free-text search (currently client-side over the returned page)
- [x] Recurring events (series + instances) — shipped on `claude/add-recurring-events-11qp9`: `event_series` schema, RRULE expander, `/series` routes, seed fixtures, `SeriesDetailPage`
- [ ] Event group chats (via Zap once M2 lands — placeholder shipped)
- [ ] Organizer tools (moderation, blacklists)
- [x] Venue pages — org-scoped venue detail page (`/venues/:orgHandle/:venueHandle`) with lineup timeline, event carousel, open/closed badge + clickable venue layer on the Explore map; `venues` + `event_lineup` tables. See [[venues]]. (Move to [[changelog/completed-features]] on merge.)
- [x] **Share button with RSVP source attribution** — event detail picker (Popover desktop / Dialog mobile) covering Instagram/Facebook/TikTok/X/WhatsApp/copy-link/system-share-sheet, injects `?source=…` into shared URLs. New `event_rsvps.share_source_first` (sticky) + `share_source_last` (overwriting) columns + `*_seen_at` timestamps. Two unauthenticated rate-limited endpoints (`POST /events/:id/share`, `/exposure`) gated by a lightweight `checkEventVisibility`. Four new bounded-cardinality counters: `pulse.events.share.invoked`, `pulse.events.share.exposure`, `pulse.rsvps.attribution.first`, `pulse.rsvps.attribution.last`. Organiser self-RSVPs and self-views excluded from attribution. See `[[event-access]]`. (Move to `[[changelog/completed-features]]` on merge.)
- [ ] Venue discovery links beyond the Explore map — link into venue pages from event detail + search surfaces (deferred from the venue-pages branch — see [[venues]])
- [ ] **Organiser attribution-analytics surface** — read path that aggregates `event_rsvps.share_source_first` / `share_source_last` into a per-event funnel (exposures → first-touch RSVPs → last-touch RSVPs by platform). Will need the composite indexes called out in `P-I3 (share-attribution)`. See `[[event-access]]`.
- [ ] **Wire Zap + future OSN-native share targets** into the share-source enum (`pulse/api/src/lib/shareSource.ts` + `pulse/app/src/lib/shareSource.ts`) once those surfaces exist. Cardinality stays bounded; today's `other` bucket absorbs them in the interim.
- [ ] Real SMS/email comms providers — `sendBlast` is stubbed (writes to `event_comms`); plug in actual delivery
- [x] **Dead metric emitters (2026-07-03 quality review)** — resolved per-emitter (2026-07-05): `metricJwksCacheLookup` + counter + attrs **deleted** (JWKS cache lives in `@shared/osn-auth-client`, uninstrumented — also closes the Platform "Dead JWKS-cache metric cleanup" row); `metricEventCreateDuration` **wired** via `withEventCreateDuration` around `createEvent`; `metricPulseHostCancelledHardDelete` **wired** into `runEventCancellationSweep` (ok per purged event, error on failed batch). (`zap/api`'s `metricWsConnection` / `metricWsMessageDelivered` remain deliberately pre-declared for the in-flight M1 WebSocket transport.) See [[observability/overview]].
- [x] **`notifyAppJoined` bridge unwired (2026-07-03 quality review)** — **Wired 2026-07-07.** `completeOnboarding` now fires `notifyAppJoined(accountId)` on the first-completion branch as a best-effort `forkDaemon` (new `pulse.onboarding.enrollment_notify{result}` metric). This inserts the `app_enrollments` row that osn-api's full-account-delete fan-out reads — without it, deleting an OSN account silently skipped Pulse. Residual gap: no join-side retry sweeper yet (unlike the leave side), so a transient osn-api outage during onboarding leaves the enrollment row uncreated until the next completion. See [[s2s-patterns]].
- [ ] **Split `pulse/api/src/routes/events.ts`** — **partially done 2026-07-07:** `createSettingsRoutes` extracted to `routes/settings.ts` (clean — it was already a separate `/me` factory). **Remaining:** extract the discovery/share/exposure routes to `routes/discovery.ts`. Deferred because those routes sit mid-chain inside the single `createEventsRoutes` Elysia builder and share closures (`runtime`, `resolveIp`, `checkPerIpLimit`, the per-IP limiters) with the CRUD/RSVP routes — extracting them needs those closures lifted into a shared helper first, so it is a larger, riskier change to the busiest route file than a same-PR cleanup warrants. (2026-07-03 quality review)
- [x] Drizzle: extract shared `createSchemaSql()` helper so adding a column is a one-file change — shipped on `claude/drizzle-pulse-todo-cX5ps`: `@pulse/db/testing` export with `createSchemaSql()` + `applySchema()`, derived from the live Drizzle schema in FK-respecting order; replaces four hand-rolled DDL blocks across `pulse/db` and `pulse/api` tests; drift-guard regression test in `pulse/db/tests/testing.test.ts`
- [ ] Verified-organisation tier (Phase 2): org accounts can run events over `MAX_EVENT_GUESTS` (1000) via per-event support flow

---

## OSN Core (`osn/api`)

- [x] Multi-account profile CRUD (P3) — create/delete/set-default profiles, maxProfiles enforcement, cascade delete, observability
- [x] Multi-account client SDK (P4) — multi-session storage, profile switching, schema validation, security hardening
- [x] Multi-account UI (P5) — profile switcher component, create form, onboarding
- [x] Multi-account privacy audit (P6) — accountId leak verification, per-profile rate limits
- [ ] Per-app vs global blocking logic (deferred — global blocking across all OSN apps for now)
- [ ] Interest profile selection (onboarding)
- [x] Third-party app authorization flow — `@osn/api` is now an OIDC provider: `/authorize`, `/authorize/context`, `/authorize/decision`, `/oidc/token`, discovery. Authorization code + PKCE (S256 only), pairwise `sub` per client sector, consent per (account, client), codes hashed + single use. See [[oidc-provider]]
- [x] OIDC deferred-hardening batch (2026-07-24) — real `auth_time` + `max_age` + enforced `prompt=login` freshness; per-request browser-binding cookie on the parked request; reserved client-id deny-list + `typ: at+jwt`; `GET/DELETE /oidc/connections` (list + revoke, revoke kills in-flight codes); DSAR export `oidc_consents` section; P-W perf batch. See [[oidc-provider]], [[changelog/security-fixes]]
- [x] **Consent screen UI** (2026-07-26) — `/authorize` in `@osn/social`, built to the spec in [[authorize-ui]]: client card, humanised scopes, profile picker when there is a real choice, `login_required` replay against the same request id, bare layout, `frame-ancestors 'none'`. Driven by `createAuthorizeClient` in `@osn/client`. The `deploy-osn-social` Pages job serves it at `https://musubi.social/authorize` (it was written against `me.cireweddings.com` and never served that hostname — the 2026-07-27 identity move retargeted it to the apex before it went live), and `OSN_AUTHORIZE_UI_URL` points there. The apex was attached to the `osn-social` Pages project on 2026-07-27 ([[production-deploy]] §5.4) — smoke-test the full round-trip once the merge deploy publishes. See [[oidc-provider]], [[social]], [[musubi-identity-migration]]
  - Review follow-ups (prep-pr, 2026-07-26). Fixed in the same PR: **S-M1** — the held answer was replayed after any successful re-auth, so on a shared device the consent could be recorded for whoever signed in second (now reconciled against the profile set); **S-L1** — `reason=login` was ignored, so consent rendered before a ceremony that had to fail first; **S-L2** — a stale profile choice survived the refetch and burnt the single-use request; **S-L4** — a 429 or a transport failure left the page on the spinner with no message and no retry.
  - Perf, same PR: the app root mounted `AuthProvider` on every route, so each consent-screen impression ran `POST /token` — a refresh **rotation** — plus a `GET /profiles` the page never reads; the provider now sits inside a `lazy()` sign-in island that loads only when a ceremony is needed. `Sidebar` was lazified off the entry chunk, the screen state machine became a `createMemo`, and the avatar dropped `loading="lazy"` (above the fold, one image). Still open: **AZ-P-I1** (issuer `preconnect`) and **AZ-P-I2** (no timeout or `AbortSignal` on the authorize client) in the Performance Backlog.
  - [ ] **S-L3** — `osn/social/public/_headers` ships `frame-ancestors 'none'` and nothing else. `/authorize` is the highest-value injection target in the product (a script in this origin can read the context and post a decision), so it wants `default-src`/`script-src`/`base-uri`/`object-src`/`form-action` too. Blocked on generating `connect-src` from `VITE_OSN_ISSUER_URL` at build time — a hardcoded issuer origin breaks sign-in per environment. Same deferral as cire/organiser's own CSP item.
  - [ ] **C-L1** — the consent screen loads `client.logoUrl` straight from the relying party's host, so a registered client sees the IP and user-agent of every user who reaches its consent screen. Either document the disclosure (the user chose that client) or proxy logos through osn-api. [[compliance/subprocessors]]
  - [ ] **A-L1** — the `<Switch>` screen transitions have no `aria-live` region, so a screen reader announces nothing when the page flips to "Taking you back…" or to a terminal state. [[compliance/eaa]]
- [x] OIDC client registration (2026-07-24) — self-serve `POST/GET/DELETE /oidc/clients`: server-generated `cid_`, secret shown once (hash at rest), https-only redirect URIs (loopback http for dev) + https-only `logo_url`, derived sector, 5-live-clients cap, owner-scoped list/disable, erasure disables + unlinks owned clients, DSAR `oidc_clients_owned` section. See [[oidc-provider]]
- [ ] OIDC `/userinfo` + `offline_access` refresh tokens — deliberately out of the first cut; third parties re-enter `/authorize` instead
- [ ] Apex worker for the identity domain — `/.well-known/webauthn` (Related Origin Requests, **five registrable labels ever**), `apple-app-site-association`, `assetlinks.json`. Blocked on the domain purchase; the OIDC provider works without it — see [[oidc-provider]]
- [ ] Native single sign-on — `ASWebAuthenticationSession` (iOS) / Custom Tabs (Android) so native apps share the system browser cookie jar and `prompt=none` works inside them
- [x] Organisation frontend — standalone `@osn/social` app delivered (2026-04-16); Tauri wrapping deferred
- [x] **`@osn/social` mobile UX overhaul** — built 2026-07-28, in PR (move to [[changelog/completed-features]] on merge). All five phases of [[social-mobile-ux]] shipped: viewport/input foundations (`dvh`, safe areas, 16 px mobile inputs, `theme-color`), responsive shell (bottom tab bar + top bar below `md`, nav shared via `nav.tsx`), bottom-sheet dialogs (`ResponsiveDialogContent`, all app call sites), touch-target/density sweep (`max-md:` 40px+ targets, `active:` states, scrollable tabs, top-center mobile toasts), viewport-verified (320/390/768/1280, zero overflow) + `DESIGN.md` **Responsive layout** section. App-scoped — no `@osn/ui` primitive edits. Prep-pr reviews clean: S-L1/P-W1/P-I1/P-I2/C-L1 all fixed in-branch (single-shell conditional mounting, sync matchMedia init, `aria-hidden` icons); five new test files cover the extracted components
- [ ] **T-S2** — `@osn/social` `Layout` shell-composition test (bare `/authorize` renders no shell / no `nav[aria-label="Primary"]`; normal routes get the shell + `pb-nav` scroll column). Deferred from the mobile-UX PR: `AuthProvider` bootstraps `POST /token` on mount, so the fixture needs a mocked provider. See [[social-mobile-ux]], [[social]]
- [x] Merge `@osn/core` into `@osn/api`, move `@osn/crypto` → `@shared/crypto`; ARC audience updated `"osn-core"` → `"osn-api"`
- [x] Step-up (sudo) tokens (M-PK1) — ES256 JWTs with `aud: "osn-step-up"`, passkey/OTP ceremonies, required on `/recovery/generate` + `/account/email/complete` — see [[step-up]]
- [x] Recovery codes reach the user (2026-07-26) — `GET /recovery/status` (counts only, no step-up, `RL_AUTH_IP_30_60`, `no-store`), `@osn/client` now sends the step-up token on `POST /recovery/generate` (it posted an empty body before, so the call always answered 403), and that gate is pinned to `purpose: "recovery_generate"` so a token minted for another ceremony cannot be replayed against it. `RecoveryCodesView` mounts in `@osn/social` Settings → Security and in the cire organiser Security panel — until now it rendered nowhere, which is why no account had codes. See [[recovery-codes]], [[step-up]]
- [x] Session introspection + per-device revocation — `GET /sessions`, `DELETE /sessions/:id`, `POST /sessions/revoke-all-other`, coarse UA labels, HMAC-peppered IP hash, `last_used_at` — see [[sessions]]
- [x] Email-change ceremony — step-up gated, OTP to new address, transactional other-session revoke, 2-per-7-days cap, `email_changes` audit table
- [x] Session + `AccountSession` types drop `refreshToken` — cookie-only first-party; `AccountSession.hasSession` replaces stored refresh token. `/logout` body no longer accepts `refresh_token`.
- [x] Cross-device login — QR-code mediated session transfer (4 endpoints: begin, status, approve, reject). In-memory store, 256-bit secret, SHA-256 hashed at rest, security_events audit + email notification. Client SDK + UI deferred to follow-on — see [[sessions]]
- [ ] **`hardDeleteAccount` leaves `organisations.owner_id` dangling** (`osn/api/src/services/account-erasure.ts:502`) — the erasure batch deletes `connections`, `blocks`, `organisation_members` and then the `users` rows, but `organisations.owner_id` is a `notNull` FK onto `users.id` (`osn/db/src/schema/index.ts:398`) and nothing in the batch touches it. Any account that owns an organisation therefore fails the hard-delete batch under FK enforcement and its `deletion_jobs` row retries forever, silently past the promised window. Needs a decided policy first — transfer ownership to another admin in `organisation_members`, or delete the org with its members — then a batch step for it. Found while reading erasure for the OIDC work; not yet reproduced against a real owner. See [[compliance/dsar]], [[identity-model]]
- [ ] **Public `orgProjection` omits `id`** (`osn/api/src/routes/organisation.ts:66`) — the REST organisation surface (create, list, get, patch) returns `handle`/`name`/`description`/`avatarUrl`/timestamps and never the `org_*` id, so a client that needs the id has no way to get one over the public API and must go through an ARC internal route. That is what cire's vendor portal does (`profileOrgs` in `cire/api/src/routes/vendor-portal.ts:52`). Either add `id` to the projection or write down that handles are the only public org address. See [[identity-model]], [[arc-tokens]]
- [ ] Recommendations SQL aggregation + compound indexes (P-W7) — push FOF counting into DB, add `connections(status, requester_id)` + `connections(status, addressee_id)` — see [[social-graph]]
- [ ] Unified `handles` reservation table (user + org handles share namespace; currently enforced at service layer — see Deferred Decisions)

---

## Zap (`zap/app` + `zap/api` + `zap/db`)

OSN's messaging app. Stack matches Pulse (Bun, Tauri+Solid, Elysia+Eden, Drizzle+SQLite, Effect.ts) unless a real reason to differ emerges. Signal Protocol lives in `@osn/crypto`, not `zap/`.

### M0 — Scaffold (remaining)

- [ ] `bunx create-tauri-app` for `@zap/app` (iOS target enabled, Solid template)
- [ ] `@zap/app` consumes `@osn/client` + `@osn/ui/auth` for sign-in (re-uses `<SignIn>` / `<Register>` from Pulse)
- [ ] Register `zap-app` and `zap-api` in `service_accounts` + `service_account_keys` (ARC issuer rows + initial key)

### M1 — 1:1 DMs (E2E)

- [ ] Signal Protocol primitives in `@shared/crypto/signal` — **PQXDH** handshake (post-quantum hybrid: X25519 + ML-KEM-768) and double ratchet. Classical-only X3DH is HNDL-exposed and must not ship for durable message ciphertext
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

## Cire (`cire/web` + `cire/organiser` + `cire/api` + `cire/db`)

Wedding-invite stack merged from cire.git (2026-06). Cire-internal feature work tracks in `cire/wiki/todo/` shards; this section holds the OSN-facing integration work. See [[cire]] and [[cire-auth]].

- [x] **`diffAgainstDb` wedding-scoping** — `cire/api/src/services/import.ts` `diffAgainstDb` is `weddingId`-scoped (tenant-isolated preview/apply/revert; `guest_events` join load-bearing). See [[cire]]. (Moved to [[changelog/completed-features]].)
- [x] **Multiple weddings (#147)** — organisers list / select / create weddings (`GET`/`POST /api/organiser/weddings`); every wedding-scoped route carries an explicit `:weddingId`; import routes rescoped to `/api/organiser/weddings/:weddingId/import/*`. See [[cire-auth]]. (Moved to [[changelog/completed-features]].)
- [x] **Co-hosts by OSN handle (#148)** — new `wedding_hosts` table + owner-or-host `weddingMember()` gate; handle → profile id resolved via ARC-gated osn-api `GET /graph/internal/profile-by-handle`. See [[cire-auth]]. (Moved to [[changelog/completed-features]].)
- [x] **Per-section invite theming (#152)** — bounded, CSS-injection-safe fonts + colours; migration `0014`. See [[cire]]. (Moved to [[changelog/completed-features]].)
- [x] **Any OSN user is a first-class organiser (#156)** — `ensureBootstrapOwner` 503 gate + `BOOTSTRAP_OWNER_PROFILE_ID` removed; migration `0015` drops `wed_bootstrap`. See [[cire-auth]]. (Moved to [[changelog/completed-features]].)
- [x] **Organiser Security / Devices section (#155)** — `PasskeysView` (list/add/rename/remove) + passkey-only step-up in the portal `SecurityPanel`. See [[passkey-primary]]. (Moved to [[changelog/completed-features]].)
- [x] **Host-preview RSVP is an interactive no-op** — the organiser host preview's RSVP was greyed out (`disabled` in preview mode); it's now fully interactive with submit short-circuited to a no-op + a "nothing you send here is saved" banner (`RsvpModal` `preview` prop). Lets a host feel the guest flow without writing RSVP data. See [[cire-landing]].
- [ ] Pulse event-feed integration — surface cire weddings in Pulse's discovery/feed. Blocked on the mechanism decision (ARC-token pull from `cire/api` vs push-on-publish into `pulse/db`) — see Deferred Decisions.
- [x] **Co-host roles (editor/viewer)** — `wedding_hosts.role` + `weddingEditor()` gate + the roles capability matrix shipped 2026-07-12 (cire platform Phase 0 PR 2; migration `0031`). See [[cire-auth]]. (Moved to [[changelog/completed-features]].)
- [ ] Guest claim-code → optional OSN account linking (frontend) — backend shipped; the guest-site "link my Pulse account" control is still to build (guests stay deliberately account-free — see [[cire-auth]]).
- [x] **IB-S-L1 / colour-allowlist duplication (#152)** — single source of truth factored into the new zero-dependency `@cire/theme` package (`isSafeCssColor`); `cire/api` (write-time) and `cire/web` (render-time) both import it, so the CSS-injection-safe guarantee can't drift — see [[cire]]. (Moved to [[changelog/security-fixes]].)

---

## Cire Landing (`cire/landing`)

Static marketing site for the apex `cireweddings.com`. Full design + deploy +
domain-migration plan in [[cire-landing]].

- [x] **Build `@cire/landing`** — static Astro + SolidJS + Tailwind v4 marketing site; brand tokens kept byte-identical to `cire/web`. Promise/features/how-it-works/craft/FAQ sections, hotlinked-Unsplash imagery (centralised + swappable in `lib/site.ts`), legal drafts, `SiteFooter`. See [[cire-landing]].
- [x] **Full-page envelope hero** — the whole first screen is the front of a sealed envelope (`WaxSealHero` + `WaxSeal.motion.ts`) that opens to unveil the page.
- [x] **Generative scroll-grown vine backdrop** — `VineCanvas` + `lib/vines/` (seeded PRNG + Catmull-Rom smoother, unit-tested for determinism); SSR roots + per-load-unique client field, vines draw on as you scroll, per-element reveal locked to the growth front. Scroll-paint culled to in-view vines; resize-regen gated to width changes. See [[cire-landing]].
- [x] **Interactive no-op demo invite** — in-page "See it live" invitation (`demo/DemoRsvp.tsx`); RSVP is fully interactive but never hits the network (test-asserted).
- [x] **Hidden testimonials** — section designed but gated behind `SHOW_TESTIMONIALS = false` until real, permissioned quotes exist.
- [x] **CI deploy** — `deploy-cire-landing` (in `deploy.yml`) ships the `cire-landing` Pages project, which now serves the apex. The push-triggered `deploy-landing-preview.yml` was deleted 2026-07-27 with the rest of the preview tier — it pushed a feature branch onto that same project's production branch, which is a live-site deploy wearing a preview's name.
- [ ] **Replace the wax-seal graphic** — the hero's seal disc is a `TODO(design)` placeholder pending a separately designed asset; only the inner seal `<div>` needs swapping. See [[cire-landing]] "Deferred".
- [ ] **Apex cutover (separate, reviewed change)** — move `cire/web` → `invite.cireweddings.com` (+301 from old invite paths), `cire/organiser` → `host.cireweddings.com` (update WebAuthn `OSN_ORIGIN`/CORS), point `PUBLIC_ORGANISER_URL`/`SITE` at the new hosts, then flip `cire/landing` onto the apex. Also fold in **S-L1/S-L2** hardening (self-host fonts, proxy imagery, drop CSP `'unsafe-inline'`; list Unsplash + Google Fonts in [[subprocessors]]). See [[cire-landing]], [[production-deploy]].
- [ ] **Real hero/gallery art** — replace the hotlinked Unsplash placeholders in `lib/site.ts` with brand photography.
- [ ] **Wire a real demo invite** — set `PUBLIC_DEMO_INVITE_URL` to a seeded read-only invitation so "See a live invite" links out instead of scrolling to the in-page demo.

### Platform roadmap (withjoy parity)

- [ ] **Gift registry** — first-class registry surface (parity with withjoy).
- [ ] **Wedding-management platform** — budget, vendors + availability + location search, pricing estimates, seating, checklist/timeline, guest comms — built out from the organiser dashboard (`host.cireweddings.com`), with guests/events decoupled from the invite as their own sources of truth. Multi-tenant `weddings` root already in place. **Phased build plan shipped 2026-07-08**: `cire/wiki/architecture/platform-plan.md` (architecture + schema sketches) + `cire/wiki/todo/platform.md` (checklist). Phase 0 (invite decoupling + wedding profile + roles) is the entry point; it also closes the co-host **roles** item in the Cire section above. See [[cire]].
- [ ] **Marketing depth** — pricing page, case studies, blog/SEO content; flip testimonials live once permissioned.

---

## Landing (`osn/landing` + `pulse/landing`)

- [x] **Build `@osn/landing`** — static Astro + SolidJS + Tailwind v4 marketing site; dark-grey / dotted-network identity (`ConstellationCanvas` backdrop + `ConnectionsHero`), connections-led copy, Apps/Principles/FAQ sections, legal drafts, tight CSP, `data-reveal` reveal. Space Grotesk + Inter. Dev port 4324. See [[osn-landing]].
- [x] **Build `@pulse/landing`** — static Astro + SolidJS + Tailwind v4 marketing site following `pulse/DESIGN.md`; colourful + fun (`PulseField` backdrop + `PulseHero`, colourful Categories showcase, Venues lineup teaser). Instrument Serif / Geist / Geist Mono. Dev port 4325; root script `dev:pulse-landing`. See [[pulse-landing]].
- [x] **CI preview deploy** — `.github/workflows/deploy-osn-pulse-landing.yml` builds + ships both sites to their own Cloudflare Pages previews on every branch push: **`osn-landing.pages.dev`** and **`osn-pulse-landing.pages.dev`** (the plain `pulse-landing` subdomain was already taken by an unrelated account). Pulse is a hybrid static + Pages Function deploy (`/api/geo`). See [[osn-landing]], [[pulse-landing]].
- [ ] **Domains** — replace the placeholder `SITE` / `PUBLIC_APP_URL` build vars with real hosts once the OSN + Pulse marketing/app domains are chosen; add custom-domain Pages bindings. See [[osn-landing]], [[pulse-landing]].
- [ ] **"State's main city" geo routing** (pulse-landing) — the hero CTA currently targets the visitor's nearest Cloudflare city; add a region → capital/major-city map so small-town visitors route to their state's main city. See [[pulse-landing]].
- [ ] **Marketing depth** — pricing, deeper feature pages, real imagery/screenshots, SEO/blog content.

---

## Verified Identity (`@osn/api` + `@osn/db` + `@shared/crypto` + `@osn/social`)

Yoti-style reusable verified-attribute layer. **Australia first** —
driver's licence (DVS), mobile driver's licence (ISO 18013-5), and
myID once AGDIS opens to private-sector relying parties (30 Nov
2026). Other countries layer onto the same provider abstraction.
Cryptography: SD-JWT VC (RFC 9901 + draft-ietf-oauth-sd-jwt-vc) over
the existing OSN ES256 ARC key. See [[verified-identity]] for the
design doc, threat model snapshot, and vendor shortlist.

### V-M0 — Foundations (no provider yet)

- [ ] DPIA filing under GDPR Art. 35 — biometric template hashes +
      identity-document data are Special Category Personal Data
      (Art. 9). Block all later milestones until filed. Add to
      [[compliance/gdpr]] and link from C-M3.
- [ ] Data map + retention + subprocessor entries: new categories
      (biometric template hash, document number hash), default
      retention 24 months from `verified_at` or until document
      expiry whichever sooner, KYC vendor as a new subprocessor
      with signed DPA. See [[compliance/data-map]],
      [[compliance/retention]], [[compliance/subprocessors]].
- [ ] Vendor RFP: Persona (M1 facial age estimation, top-scoring AU
      trial vendor), idvPacific vs Equifax IDMatrix (M2 DVS
      gateway), MATTR/GBG (M3 mDL acceptance). Trade-off matrix
      lives at `wiki/verified-identity/vendor-rfp.md`.
- [ ] DB schema in `@osn/db`: `verification_providers`,
      `verification_runs`, `verified_attributes` (encrypted
      `value` column), `presentations`. New `security_events`
      kinds: `identity_verified`, `identity_presentation_issued`.
- [ ] SD-JWT VC issuer in `@shared/crypto/vc` — salted-hash
      disclosures, `aud`-bound presentations, `jti` single-use
      store mirroring [[step-up]]. ES256 key reused from ARC
      issuer; new credential audience `osn-vc`.
- [ ] `/.well-known/openid-credential-issuer` metadata + JWKS
      reuse from existing `/.well-known/jwks.json`.
- [ ] Observability: `osn.identity.verification.runs{kind, outcome}`
      counter, `osn.identity.verification.duration{kind, provider}`
      histogram, `osn.identity.presentation.issued{audience, claims}`
      counter (claims as bounded enum, not free-form).

### V-M1 — Facial age estimation

Lowest regulatory bar; closes the social-media-minimum-age (10 Dec
2025) compliance gap before harder document flows are wired.

- [ ] Persona (or chosen vendor) integration in
      `osn/api/src/services/identity/age-estimate.ts`. Pure HTTP +
      vendor SDK; selfie capture via WebAuthn-style platform API.
- [ ] `POST /identity/verify/begin { kind: "age_estimate" }` +
      `POST /identity/verify/complete` (step-up gated). On
      success, mint `age_band` + (if estimate ≥ 16 with margin)
      `age_over_16: true` attributes. Source image discarded after
      vendor returns the estimate.
- [ ] **Under-13 termination branch**: if facial-age-estimate
      returns ≤ 13 with confidence margin, abort the flow,
      do **not** persist the estimate value, do **not** log
      the value, write a generic `age_estimate_below_threshold`
      `security_event`, and return a fixed-shape failure to the
      client. This is COPPA "actual knowledge" — the moment OSN
      learns of a likely under-13 user it must not retain the
      signal that triggered the inference. See [[compliance/coppa]].
- [ ] `@osn/social` Settings → Identity tab: entry-point card
      "Confirm you're old enough" + selfie ceremony UI.
- [ ] Tighten C-H8 (registration age gate): if a verified
      `age_over_16` attribute exists, skip the self-declared
      birthdate path entirely. See [[compliance/coppa]].
- [ ] Tests: provider mock layer; refusal on margin-of-error
      bands; revocation on `DELETE /identity/attributes/age_band`.

### V-M2 — AU document verification (DVS + selfie + face-match)

- [ ] Department of Home Affairs DVS registration paperwork +
      DVS-approved consent statement (verbatim) shown before each
      DVS call; consent record retained.
- [ ] DVS gateway provider integration (idvPacific or Equifax
      IDMatrix). Document capture + OCR client-side; submit
      extracted fields to DVS for yes/no match.
- [ ] Liveness selfie + face-match against the licence photo.
      Provider returns face-match score; OSN refuses below
      configurable threshold.
- [ ] Mint attributes: `dob`, `given_name`, `family_name`,
      `country=AU`, `document_type`, `document_expires_at`,
      `document_number_hash` (SHA-256 + per-attribute pepper —
      lets us refuse Sybil re-use without retaining the number).
      Pre-compute boolean predicates `age_over_16`, `age_over_18`
      alongside `dob`.
- [ ] Settings → Identity: list verified attributes with
      provenance ("Verified 12 Jan 2026 via NSW driver licence")
      and per-attribute revoke.
- [ ] Tests: DVS no-match path returns generic failure (no
      enumeration oracle); face-match below threshold; replay of
      same document number across accounts blocked.

### V-M3 — mDL acceptance (ISO 18013-5 / 18013-7)

- [ ] CBOR/COSE verifier for state-issued mDL presentations
      (NSW + QLD live; others as they roll out late 2026). MATTR
      SDK or hand-rolled — decide in V-M0 vendor RFP.
- [ ] Re-issue mDL claims as OSN SD-JWT VCs so downstream
      relying parties see one credential format on the holder
      side.
- [ ] Settings → Identity: "Verify with your phone's digital
      driver licence" entry alongside the document upload flow.

### V-M4 — Relying-party API (Pulse, Zap, third-party)

- [ ] `POST /identity/presentation/request` (RP-facing) — accepts
      claim set + audience + nonce, returns OAuth-style consent
      URL.
- [ ] `POST /identity/presentation/issue` (user-facing) — after
      consent + step-up, releases SD-JWT VC for **only** the
      requested claims with the audience binding.
- [ ] OpenID4VP wire format so external apps can integrate
      against a published spec rather than an OSN-bespoke one.
- [ ] Pulse: optional "verified attendees only" event setting +
      "host requires verified given-name" gate on RSVP.
- [ ] Zap M3: trader-traceability flow (DSA Art. 30, C-M12)
      consumes verified `given_name` / `country` / business
      registration ID.
- [ ] Per-RP audit trail in `presentations` + user-facing
      "Connected apps" view showing every prior presentation.

### V-M5 — myID / AGDIS

Unblocked 30 Nov 2026 when private-sector relying parties become
eligible under the Digital ID Act 2024.

- [ ] AGDIS accreditation paperwork (relying-party tier).
- [ ] Accept myID assertion as a verification source — yields
      higher-assurance attributes than DVS for the same fields,
      plus reduces vendor lock-in to a single KYC provider.
- [ ] Settings → Identity: "Verify with myID" surface.

### V-M6 — Other countries

- [ ] UK: DIATF-accredited provider (Yoti, Onfido, Persona) for
      passport / driving-licence verification.
- [ ] EU: eIDAS 2.0 / EUDI Wallet acceptance (SD-JWT VC
      interoperable on the wire — same verifier code).
- [ ] US: state mDL acceptance (Apple / Google wallet) as it
      rolls out; plus document-verification provider for
      driver's licence + state ID.

### Cross-cutting / open questions

- [ ] Which verified attributes are "always public" once minted
      (e.g. `country` for compliance routing) vs always
      consent-gated (DOB, full name)?
- [ ] BBS+ unlinkable VC vs SD-JWT-per-audience for cross-RP
      correlation defence — defer to v2 unless a documented
      threat lands.
- [ ] How does verified identity interact with multi-account
      profiles (P3-P6)? Verification is account-level; profile
      switching exposes the same attributes — is that the right
      ergonomic, or should profile-A be able to present `age_over_18`
      while profile-B presents nothing?
- [ ] Step-up requirement on every presentation vs cached
      consent (e.g. "Pulse can re-use my `age_over_16` for 30
      days without prompting") — UX vs privacy trade-off.

---

## Platform

### Docs / wiki

- [x] Fix the wiki drift found by the 2026-07-22 writing-rules pass. _Done 2026-07-22 (`docs/wiki-fact-reconcile`)._ The copy-edit changed prose only, so about 25 factual contradictions were flagged and left in place — the full list is in the pull request body. The worst: `[[production-deploy]]` §5.3–5.4 still deploys `cire/web` as a Pages project on the apex; `[[observability-setup]]` and `[[rate-limit-incident]]` still assume the Bun/Node stack that the Workers migration replaced; `[[monorepo-structure]]` says four top-level directories and "SQLite (migrating to Supabase)"; `[[component-library]]` deprecates `bx()` and still tells you to use it; `[[email]]`, `[[passkey-primary]]` and `[[subprocessors]]` disagree about whether Resend or Cloudflare Email Service is live
- [x] Delete or redirect `wiki/apps/landing.md` — it documented `@osn/landing` as unbuilt with the deploy target undecided, which `[[osn-landing]]` contradicts in full. _Done: deleted; nothing linked to it._
- [x] Reconcile the duplicate finding IDs in this file — _Done: the July rows became **C-L29**–**C-L32**; **C-L4**/**C-L5**/**C-L6** stay with the GitHub-hardening / penetration-test / insurance rows the `[[compliance/access-control]]`, `[[compliance/soc2]]` and `[[compliance/breach-response]]` pages already cite by those IDs. The two S-L23 rows were the same closed finding recorded twice._ (C-L4, C-L5, C-L6, S-L23 each appear on two or three rows) and the eight items recorded as both shipped and open
- [x] Run the same writing-rules pass over `cire/wiki/` — _Done in PR #308 (`docs/cire-wiki-writing-rules`): 22 of 30 pages edited, 62,982 → 62,959 words, six contradictions logged under "Docs drift" in `cire/wiki/todo/status.md`._ (30 pages, ~62k words) — the 2026-07-22 pass covered only the root `wiki/` tree

### Pulse events API (`pulse/api`)

- [ ] Batch status-transition `UPDATE`s in `listEvents`/`listTodayEvents` (currently N individual writes)
- [x] Eliminate extra `getEvent` round-trip in `createEvent` via `RETURNING *` — was already shipped as P-I7 (`db.insert(events).values(row).returning()` in `services/events.ts`); stale row checked off 2026-07-05
- [x] S2S graph access: graphBridge migrated to ARC-token HTTP calls against `/graph/internal/*` (direct @osn/core import removed)
- [ ] OSN/messaging domain modules
- [ ] WebSocket setup for real-time
- [ ] REST endpoints for third-party consumers
- [x] Dead JWKS-cache metric cleanup — **deleted** (2026-07-05): `metricJwksCacheLookup` + `authJwksCacheLookups` counter + `JwksCacheLookupAttrs` removed from `pulse/api/src/metrics.ts`; the now-unused `JwksCacheResult` type removed from `@shared/observability`. Re-add in the shared package if `@shared/osn-auth-client`'s cache is ever instrumented — see [[observability/overview]]

### Client SDK (`osn/client`)

- [ ] Export an `isAuthExpiredError()` helper from `@osn/client` — Effect's FiberFailure wrapping defeats `instanceof AuthExpiredError`, so consumers string-match the error printout today (see `cire/organiser/src/lib/api.ts:isAuthExpired`). Ship a tag/printout-aware predicate next to the error class — see [[cire-auth]]

### Database (`osn/db`, `pulse/db`)

- [x] Local DB dev tooling — root + per-package `db:reset` across `osn/db`/`pulse/db`/`zap/db`/`cire/db` (wipe → `db:push` → seed; seed skipped where no seed file, without swallowing real failures). `cire/db` `db:seed` runs `scripts/cire-db-seed.sh` (seeds local D1 + re-points the bootstrap wedding owner from `CIRE_DEV_OWNER_PROFILE_ID`); `cire/db` drizzle.config points `db:studio` at the local miniflare D1 sqlite; `cire/api` `local.ts` re-points the bootstrap wedding owner so the signed-in dev account owns it. Dev-only — no shipped runtime code.
- [x] OSN Core: session schema — server-side sessions with SHA-256 hashed opaque tokens (Copenhagen Book C1)
- [ ] Pulse: event series schema
- [ ] Add indexes on `status` and `category` columns in pulse-db events schema
- [x] Mirror `@pulse/db/testing` (`createSchemaSql()` + `applySchema()`) into `@osn/db` and `@zap/db` — both now derive DDL from the live Drizzle schema via `getTableConfig()` in FK order, used by the Miniflare D1 integration tests. (Migrating the hand-rolled `osn/api/tests/helpers/db.ts` unit fixtures onto it is still open but optional.)

### Four-environment DB story (local / dev / staging / prod) — see [[database-environments]]

`local` = bun:sqlite (fast/free in-memory tests + dev); `dev`/`staging`/`prod` = Cloudflare D1 on Workers. Foundation + Zap + Pulse + OSN DB layer landed.

- [x] `@shared/db-utils`: driver-agnostic `Db<S>` type, `createD1Db`/`makeD1DbLive`, `dbQuery` bridge, `commitBatch` (atomic `db.batch` on D1 / sequential on bun:sqlite); `makeDbLive` accepts broadened tags
- [x] Zap migrated end-to-end: `createApp` factory (`aot:false`) + `local.ts` (Bun.serve) + `index.ts` (Workers/D1) + `wrangler.toml` (dev/staging/prod) + Miniflare integration test + first generated D1 migration
- [x] Pulse migrated end-to-end: 5 `accountErasure.ts` transactions → `commitBatch`; `createApp`/`local.ts`/`index.ts`/`wrangler.toml`/Miniflare test (`bun run --cwd pulse/api test:d1`)
- [x] OSN core **DB layer** migrated: all 17 `db.transaction()` calls across `auth`/`profile`/`graph`/`organisation`/`account-erasure` → `commitBatch`, preserving the S-H1/S-M2 atomicity invariants (UNIQUE-constraint guards for handle/email races; count-guarded conditional DELETE for the last-passkey invariant). `@osn/db` type broadened + D1 layer; Miniflare integration test (`bun run --cwd osn/api test:d1`); `wrangler.toml` for D1 migration tooling.
- [ ] **OSN core → Workers hosting** (in progress):
  - [x] **P1 — `createApp` factory + `local.ts` Bun entry** (PR #131): osn-api now uses the same factory/entry split as Zap/Pulse — `createApp` builds the Elysia app from injected deps, `local.ts` is the `Bun.serve` entry. Until the remaining items land, osn-api still runs only as the Bun.serve `local` host even though its D1 DB layer is ready.
  - [ ] **P2 — Workers-compatible Redis backend** (in flight): replace ioredis (rate-limiters, rotated-session + step-up JTI stores) with an Upstash REST backend.
  - [ ] **D1 wiring** in the request path: move env-based JWT-key loading into the request path so the Worker has no module-load env dependency.
  - [ ] **Workers `index.ts` entry** (+ `main` in `osn/api/wrangler.toml`) to actually host osn-api on Workers.
- [ ] **Pulse/Workers cron**: the leave-app deletion sweepers run on the long-lived `local` host (`pulse/api/src/local.ts`). On Workers they belong on a Cron Trigger (`[triggers] crons` + `scheduled()` handler).

**Resolved during prep-pr review:** `[x]` build blocker — `@shared/db-utils` no longer statically imports `bun:sqlite` (lazy indirect imports) so Worker bundles build; `[x]` **S-H1** — Zap Worker fails closed on missing `OSN_JWT_SECRET` + non-local dev-secret fallback removed; `[x]` **T-M1** — `commitBatch` unit tests added. See [[database-environments]].

**Deferred review follow-ups (non-blocking):**
- [ ] **P-W1** — `refreshTokens` re-SELECTs the session row that `verifyRefreshToken` already loaded; return the metadata instead (one extra RTT on the hottest auth path, only bites once osn-api runs on D1 — gated on the Workers-hosting item above). [[sessions]]
- [ ] **S-L1** — `deletePasskey` returns `remaining` + writes the audit row from the pre-read count even when the count-guarded DELETE matched 0 rows (race loser). Inspect rows-affected before auditing. [[passkey-primary]]
- [ ] **S-L2** — `commitBatch` bun:sqlite branch has no rollback (local/tests only); optionally wrap in a sync transaction for local atomicity parity.
- [ ] **T-M2** — port `pulse/db`'s `tests/testing.test.ts` to `@osn/db` + `@zap/db` (the new schema-reflection emitters are untested in the unit lane).
- [ ] **T-E1** — add a unit test for `completeEmailChange`'s UNIQUE-conflict catch branch (the constraint guard that replaced transactional rollback).
- [ ] **T-S1** — add a concurrent-delete Miniflare case asserting the last-passkey count-guarded DELETE leaves exactly one passkey on real D1.
- [ ] **T-S2** — smoke-test `createApp`/`local.ts` bootstrap for pulse/api + zap/api.

### Crypto (`osn/crypto`)

- [x] JWKS endpoint + ES256 access tokens — `GET /.well-known/jwks.json` live in `@osn/api`; `@pulse/api` verifies via JWKS cache — see [[arc-tokens]]
- [ ] JWKS URL fallback in `resolvePublicKey` for third-party apps (currently first-party only via `service_account_keys`)
- [x] **W7 issuer hardening** — `verifyArcToken` gains optional `expectedIssuer` (X1: `requireArc` binds signed `iss` to the kid→issuer DB row; Pulse receiver passes it too); ARC token cache key now includes `ttl` + canonicalised scope (X3); ARC public-key cache TTL configurable via `ARC_PUBLIC_KEY_CACHE_TTL_SECONDS` (X4); `@shared/osn-auth-client` `extractClaims`/`osnAuth` gain optional `issuer` + 30s `clockTolerance` (X2, issuer optional/unset for rollout safety); `@shared/redis` memory `eval` asserts the rate-limit script (X5). See [[arc-tokens]]. (Move to `[[changelog/completed-features]]` on merge.)
- [ ] **Enforce access-token `issuer` in downstream verifiers** — once all live access tokens carry a matching `iss`, set `issuer` on `@shared/osn-auth-client` `osnAuth` consumers (currently optional/unset for rollout safety, X2).

### UI Components (`osn/ui`)

- [x] `RecoveryCodesView` exported at `@osn/ui/auth/RecoveryCodesView` and mounted in both apps; `StepUpDialog` takes a `purpose` prop and forwards it to `/step-up/{passkey,otp}/complete` — see [[step-up]]
- [ ] Loading skeleton for the recovery-codes status line — today the generate button is simply disabled until the first `GET /recovery/status` read settles, which reads as a dead button on a slow link. Cosmetic; do it when the panel next gets design attention — see [[recovery-codes]]
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

**Phase 4 — ARC key revocation fan-out (X4 follow-up) — see [[arc-tokens]]**
- [ ] Redis pub/sub eviction of `service_account_keys` revocations across processes — publish `(kid)` on revoke; every process subscribes and calls `evictPublicKeyCacheEntry(kid)`. Closes the ≤5-min cross-process revocation window (currently bounded by `ARC_PUBLIC_KEY_CACHE_TTL_SECONDS`, default 300).

**Observability (Redis)**
- [ ] Logs: `Effect.logError` on Redis connection failures + command errors; `Effect.logWarning` on fallback-to-in-memory transitions; add `redisPassword` / `redis_password` to redaction deny-list
- [ ] Traces: `Effect.withSpan("redis.rate_limit.check")`, `Effect.withSpan("redis.connection.health")`, `Effect.withSpan("redis.auth_state.get|set")` (Phase 4)
- [ ] Metrics: `redis.command.duration` histogram, `redis.command.errors` counter, `redis.connection.state` gauge; bounded attrs
- [ ] Capacity: `redis.memory.bytes` gauge (from `INFO memory`; alert at 80% of `maxmemory`), `redis.store.keys` gauge per namespace

---

## Security Backlog

Open findings only. Completed fixes move to [[changelog/security-fixes]].

### High

- [x] S-H1 (client) — Refresh token sent in JSON body to `/profiles/list`, `/profiles/switch`, `/profiles/create`, `/profiles/delete`. **Fixed** — all profile endpoints now authenticate via `Authorization: Bearer <access_token>` header; refresh token no longer sent in request body — see [[identity-model]]
- [x] S-H21 — Dev-mode `console.log` of OTP codes + recipient email in `osn/core/src/services/auth.ts`. **Fixed** — already uses `Effect.logDebug` (not `console.log`); guard tightened to `OSN_ENV` in log-level-debug PR.
- [x] S-H100 — Revoked ARC keys valid for 5 min after revocation (in-process cache bypass). **Fixed** — `evictPublicKeyCacheEntry(kid)` called immediately on revoke; `publicKeyCache` stores `allowedScopes` for cache-hit scope validation — see [[arc-tokens]]
- [x] S-H101 — `INTERNAL_SERVICE_SECRET` comparison not timing-safe. **Fixed** — `crypto.timingSafeEqual` in both `/register-service` and `/service-keys/:keyId` — see [[arc-tokens]]
- [x] S-H (astro-ssrf) `GHSA-2pvr-wf23-7pc7` — Astro Host-header SSRF in the prerendered error-page fetch (`astro <6.4.6` did not validate request origin against `allowedDomains`); was flagged on **every push** by the pre-push `bun audit --audit-level=high` gate across `@cire/web`, `@cire/organiser`, `@osn/landing`. **Fixed** — direct `astro` bump `^6.4.2` → `^6.4.6` in all three packages (no override; resolves to 6.4.6, lowest patched). Also clears bundled moderate `GHSA-jrpj-wcv7-9fh9` (spread-prop XSS). See [[changelog/security-fixes]].
- [x] S-H (undici-tls) `GHSA-vmh5-mc38-953g` — undici TLS cert-validation bypass via dropped `requestTls` in SOCKS5 `ProxyAgent` (`undici >=7.23.0 <7.28.0`); transitive via `jsdom@29` (`@cire/web`) + `miniflare@4` (`@cire/api`, which **pins** `undici@7.24.8`). Also flagged on every push. **Fixed** — narrowest root `overrides` entry `"undici": "^7.28.0"` (the miniflare pin rules out a parent bump); resolves both copies to 7.28.0. Also clears bundled moderate `GHSA-pr7r-676h-xcf6`. Test/build-tooling-only, no deployed-Worker path. See [[changelog/security-fixes]].

### Medium

- [x] S-M1 (passkey-cookieless-revocation) — Passkey add/remove read the caller's own session only from the HttpOnly cookie, so a Bearer-authenticated call with no cookie looked sessionless and both paths revoked **every** session on the account. **Fixed** — access tokens carry an `osn_sid` binding (`sha256(session_hash + ":" + profile_id)`, 128 bits, per-profile so P6 holds); routes call one helper, `resolveCallerSession`, where the cookie wins only when it names a live session and the binding answers otherwise, and with neither the account-wide wipe still stands — see [[changelog/security-fixes]], [[sessions]]
- [x] S-M2 (osn-sid-rotated-session) — an `osn_sid` that names a session already rotated out (or LRU-evicted past `MAX_SESSIONS_PER_ACCOUNT`) matched no row, so passkey register/delete fell back to revoking **every** session. **Fixed** — `classifyCallerSession` now distinguishes `resolved` / `none` (genuinely credential-less → the intended H1 wipe) / `stale` (a binding WAS presented but names no live row); the destructive routes fail closed (`409`, "re-authenticate") on `stale` instead of wiping the account — see [[sessions]]

### Auth PR review (#315–#324) — remaining open

- [ ] S-L3 (oidc-parked-request-consume) — the parked authorize request is loaded then deleted in two store calls, so two concurrent decisions from the same (binding-cookie-holding) browser could each mint a code sharing one nonce. Bounded (same account/client/scope, codes single-use, one browser). Fix: atomic take-and-delete on the ceremony store (Redis `GETDEL`) — see [[oidc-provider]]
- [ ] S-L (access-token-revocation-window) — session revocation does not kill an already-issued access token on non-destructive Bearer routes; it lives out its ≤5-min TTL (destructive passkey routes now fail closed on a stale binding, see S-M2). Inherent to the stateless-JWT model and already captured by S-M20; noted here for completeness.
- [ ] S-L (cire-back-channel-caller) — cire-api now exposes `POST /internal/revoke-organiser-sessions` (shared-secret bearer, fail-closed 503), but **osn-api must be wired to call it** on `DELETE /oidc/connections` and account deletion, and `CIRE_INTERNAL_REVOKE_SECRET` provisioned on both sides, before an OSN-side revoke actually kills the cire session early — see [[cire-auth]]
- [ ] S-L3 (social-consent-csp) — `@osn/social` `_headers` still has no `script-src`/`connect-src` (object-src/base-uri/form-action are now pinned). Needs a build-time policy generated from `VITE_OSN_ISSUER_URL` against the emitted bundle so an injected script can't auto-POST an approval — see [[authorize-ui]]
- [ ] OPS (musubi-reenrolment) — cutover step 8 is still unchecked: both prod accounts hang entirely on recovery codes (no passkey re-enrolled under the new RP ID). Complete recovery login → OTP step-up → enroll passkey → regenerate codes — see [[musubi-identity-migration]]
- [ ] OPS (stale-preview-redirect-uri) — the live first-party `cid_cire` client still lists the dead `https://api-preview.cireweddings.com/...` redirect URI in prod D1; prune it — see [[production-deploy]]
- [ ] OPS (orphaned-osn-social-preview) — the `osn-social-preview` Pages project (baked against the prod issuer) is still deployed; `wrangler pages project delete osn-social-preview`
- [ ] S-M (preview-ci-prod-token) — a preview workflow that runs on non-`main` feature-branch pushes under `environment: production` hands the shared prod `CLOUDFLARE_API_TOKEN` to unreviewed branch content: a `push`-triggered workflow runs the file *as it exists on the pushed branch*, so anyone with write access can add a step that exfiltrates the token past log masking. Fix: a dedicated `preview` GitHub environment holding a least-privilege token scoped to `Pages:Edit` on the preview projects only, with the prod token kept to main-only deploys. (PR #301 added `permissions: contents: read` and `--frozen-lockfile`; token scoping still open.) **Nearly closed by deletion:** three of the four workflows are gone — `deploy-osn-social-preview.yml` (2026-07-27, the identity app's preview could never exercise auth anyway), then `deploy-cire-preview.yml` and `deploy-landing-preview.yml` with the preview-tier teardown. **`deploy-osn-pulse-landing.yml` is the only one left**, so the fix is now one workflow wide.
- [ ] S-M1 (arc-key-scopes) — ARC scope authorisation is **service-granular**: `allowedScopes` lives on `service_accounts` (one row per serviceId, `/register-service` upsert = full replace) while keys live per-`kid` in `service_account_keys`. pulse-api registers two keys (graphBridge + leave-app) under one serviceId, so per-key least privilege between them is structurally impossible — either key can mint any scope in the service union, defeating the blast-radius separation `pulse/api/src/lib/outbound-arc.ts` was designed for. **Mitigated 2026-07-05** (both registrations + seed carry the identical union so scope state is at least deterministic — see [[changelog/security-fixes]]); the real fix is a per-key `allowed_scopes` column on `service_account_keys` + `resolvePublicKey` checking the key's scopes. Raised as S-H1 in the prep-pr review of the hardening sweep — see [[arc-tokens]]
- [ ] S-M1 — `verifyAccessToken` rejects tokens missing `handle` claim — treat missing as `null` during transition
- [ ] S-M2 (pulse-discovery) — friends predicate assumes the OSN social graph is symmetric. Today this is a wiki note; if asymmetric follows / blocks ever land, the RSVP branch must additionally verify `viewerId ∈ RSVPer.connections` not only `RSVPer ∈ viewerId.connections` — see `[[event-access]]`
- [x] S-M3 — No "resend code" button after registration OTP; SMTP failure = claimed handle with no recovery — **Fixed**: OTP input component now shows "Resend code" button on error with 30s cooldown
- [ ] S-M4 — Legacy `POST /register` returns raw `String(catch)` — extend `publicError()` mapper
- [ ] S-M5 — `displayName` in JWT (1h TTL) — stale after profile update
- [x] S-M6 — Wildcard CORS on auth server. **Fixed** — `cors()` consumes `OSN_CORS_ORIGIN`; local dev falls back to the monorepo Tauri dev ports (`http://localhost:1420`, `http://localhost:1422`); non-local deploys fail-closed at boot via `assertCorsOriginsConfigured` — see `[[arc-tokens]]`
- [ ] S-M11 — Magic-link tokens use `crypto.randomUUID` without additional entropy hardening
- [ ] S-M13 — Photon geocoding sends keystrokes to third-party with no user notice — add consent UI or proxy
- [ ] S-M14 — Pulse `REDIRECT_URI` falls back to `window.location.origin` — validate allowed redirect URIs server-side (see S-H3)
- [ ] S-M19 — Legacy `/register` does not lowercase emails — add `lower(email)` unique index
- [x] S-M20 — Refresh tokens in `localStorage` — XSS = permanent account takeover. **Mitigated** by C3 (refresh tokens in HttpOnly cookie) + Phase 4 short access-token TTL (5 min) with `authFetch` silent-refresh. Access token remains in `localStorage` but blast radius is ≤5 min. See [[identity-model]]
- [ ] S-M21 — `/register/begin` differential timing oracle on silent no-op branch
- [ ] S-M22 (account-deletion) — Pulse ARC key registry is in-memory only (`pulse/api/src/lib/arc-middleware.ts`). Restart drops registrations; osn-api eventually re-registers but there's a window where Pulse rejects valid ARC tokens (DoS) and any in-flight account-deletion fan-out fails. Persist a small `service_accounts` / `service_account_keys` table in `pulse/db` mirroring the osn-api schema — see [[arc-tokens]]
- [ ] S-M23 (account-deletion) — `POST /account/restore` only requires the cancellation session cookie; a passive cookie thief at deletion time can DoS the user for the rest of the 7-day grace window. Add an OTP-to-email re-confirm before honouring the restore — see [[wiki/compliance/dsar]]
- [ ] S-M24 (account-deletion) — No rate limit on `/internal/{step-up/verify, app-enrollment/{leave,join}, account-deleted}` ARC routes. Add a per-kid limiter at the ARC middleware layer (60 req/min per kid) — see [[arc-tokens]]
- [ ] S-M25 (account-deletion) — `/internal/app-enrollment/leave` accepts an ARC-authenticated body-supplied `account_id` without a fresh step-up token (the verify endpoint consumed the JTI). Residual confused-deputy risk: a compromised Pulse instance can flip arbitrary enrollments. Considered: a single-use server-issued "leave-app token" returned by `/internal/step-up/verify` and required by the leave endpoint. Defer until rate-limit (S-M24) lands; combined risk is low enough — see [[wiki/compliance/dsar]]
- [x] S-M34 — Rate limiter trusted `X-Forwarded-For` without a reverse-proxy guarantee. **Fixed** — `getClientIp(headers, options?)` in `@shared/rate-limit` now resolves the keying IP under a fail-closed `ClientIpOptions` trust policy (`trustCloudflare` → `cf-connecting-ip`; `trustedProxyCount: N` → Nth-from-right of XFF; else socket peer), exporting `UNRESOLVED_IP` / `isUnresolvedIp` / `isValidIp`. `@osn/api` opts in via `TRUSTED_PROXY_COUNT` (default 0 = socket-peer; startup warning when unset in non-local) and denies (429) unresolved IPs instead of bucketing them. Legacy no-options form kept `@deprecated` so Pulse/Zap/Cire keep building until their own opt-in workstreams (integration notes in [[rate-limiting]]). Also transitively closes **S-L2 (share-attribution)**: Pulse share / exposure endpoints key off the same `getClientIp`, so a spoofable left-most-XFF could forge the share-source attribution IP; hardening the shared helper removes that vector once Pulse passes the options — see [[rate-limiting]], [[event-access]]
- [ ] S-M35 — Redirect URI allowlist matches origin only, not exact URI per RFC 9700 §4.1.3
- [ ] S-M43 — No rate limiting on `/graph/internal/*` S2S endpoints — see [[arc-tokens]]
- [x] S-M44 — `/register-service` stored JWK without verifying it could be imported. **Fixed** — `importKeyFromJwk` called before DB upsert; returns 400 on invalid key — see [[arc-tokens]]
- [x] S-M100 — `peekClaims` used `atob()` which breaks on base64url (`-`/`_` in UUID kids). **Fixed** — `decodeJwtSegment` converts base64url → base64 before decode (RFC 7515 §2) — see [[arc-tokens]]
- [x] S-M101 — `/register-service` stored arbitrary `allowedScopes` without server-side validation. **Fixed** — `PERMITTED_SCOPES` allowlist in `graph-internal.ts`; unknown scopes return 400 — see [[arc-tokens]]
- [x] S-M102 — `resolvePublicKey` cache hit skipped scope check when `tokenScopes` empty. **Fixed** — cache entry now stores `allowedScopes`; scope validated on every cache hit — see [[arc-tokens]]
- [x] S-M1 (pulse-onboarding) — `/graph/internal/profile-account` was gated only by the generic `graph:read` scope. **Fixed (2026-07-05)** — dedicated `graph:resolve-account` scope added to `PERMITTED_SCOPES` and required on the endpoint; pulse-api registers + requests it (graphBridge), cire-api's account-link resolver requests it (its prod registration must be widened — see [[production-deploy]] §6); a `graph:read`-only token now gets 401 (regression-tested). See [[pulse-onboarding]], [[changelog/security-fixes]]
- [x] S-M1 (zap) — No rate limiting on Zap API endpoints. **Fixed** — per-IP write limiters on `POST /chats`, `/chats/:id/members`, `/chats/:id/messages` (`createDefaultZapRateLimiters`); fail-closed — see [[rate-limiting]]
- [x] S-H1 (zap) — Zap write-endpoint rate limiters keyed off the legacy spoofable `getClientIp(headers)` (no trust policy), so a client could forge `x-forwarded-for` to evade or amplify the per-IP limit. **Fixed (PR #116 review)** — Zap is a Cloudflare Worker, so the limiter now resolves the key via `getClientIp(headers, { trustCloudflare: true })` (validated `cf-connecting-ip`) and denies (429) when `isUnresolvedIp(ip)` is true, mirroring cire's Worker (`zap/api/src/routes/chats.ts` createChat/addMember/sendMessage) — see [[rate-limiting]]
- [x] S-M2 (zap) — CORS wildcard on `@zap/api`. **Fixed** — `cors()` consumes `ZAP_CORS_ORIGIN`; local dev falls back to the monorepo Tauri dev ports (`:1420`, `:1422`); non-local deploys fail closed at boot via `assertCorsOriginsConfigured` (`zap/api/src/lib/cors-config.ts`, mirrors OSN's `OSN_CORS_ORIGIN`) — see [[apps/zap]]
- [ ] S-M3 (zap) — `zapBridge.provisionEventChat` does not verify caller owns event
- [ ] S-M4 (zap) — Non-atomic cross-DB writes in `zapBridge.provisionEventChat`
- [ ] S-M5 (zap) — `addEventChatMember` does not verify chat is type "event"
- [ ] S-M6 (zap) — Truncated UUIDs (12 hex chars = 48 bits)
- [x] S-L1 (multi) — `maxProfiles` column set to 5 but never enforced. **Fixed in P3** — `createProfile` checks count vs `accounts.maxProfiles`
- [x] S-L2 (multi) — Email duplication between `accounts.email` and `users.email`. **Resolved** — `users` table has no `email` column; all email access via JOIN to `accounts`
- [x] S-H1 (session) — In-memory `rotatedSessions` map did not survive restarts or scale across pods. **Fixed** — `RotatedSessionStore` abstraction with Redis-backed impl wired in `osn/api/src/index.ts`; fail-open on Redis error so outages can't manufacture false-positive family revocations — see [[sessions]]
- [x] S-M2 (auth) — `resolveAccessTokenPrincipal` and `resolveAccountId` duplicated across `routes/auth.ts` and `routes/profile.ts`. Extract shared Elysia derive — see [[identity-model]]
- [ ] S-M2 (cdl) — No per-entry failed-secret attempt counter on CDL poll/approve/reject — IP rate limiter is the only brute-force defence; 256-bit entropy makes this low-risk but breaks the MAX_OTP_ATTEMPTS defence-in-depth precedent — see [[sessions]]
- [ ] S-H1 (org) — `listMembers` service returns full profile rows; route projects, but service should restrict
- [ ] S-M1 (org) — `GET /organisations/:handle/members` has no membership gate
- [ ] S-M3 (org) — `getOrganisation` returns `ownerId` internal ID
- [x] S-M1 (passkey) — `deletePasskey` last-passkey/recovery-code lockout guard was SELECT-then-DELETE outside a transaction; two concurrent deletes could bypass it. **Fixed** — gate + delete + security-event insert wrapped in `db.transaction`, returns tagged result; collapses TOCTOU window to zero — see [[identity-model]]
- [x] S-M2 (passkey) — `PATCH /passkeys/:id` had no step-up gate; XSS-captured access token could swap labels to mislead the user before a delete. **Fixed** — rename now uses the same step-up gate as delete (`passkeyDeleteAllowedAmr`); client + UI thread the token through — see [[identity-model]]
- [x] S-M3 (passkey) — Discoverable login did not cross-check assertion `userHandle` against the credential row's `accountId`. **Fixed** — verifier decodes the base64url userHandle and compares to `accounts.passkeyUserId` before completing the ceremony — see [[identity-model]]
- [x] S-M1 (recovery) — `consumeRecoveryCode` was check-then-act: it SELECTed the code row and tested `usedAt === null` outside the write, so two concurrent requests with the same code could both pass and double-consume (each wiping sessions + writing an audit row). **Fixed (PR #116 review)** — the consume is now a compare-and-swap (`UPDATE recovery_codes SET usedAt = :now WHERE id = :id AND usedAt IS NULL`); 0 rows-affected means another request won the race, so the session wipe + audit insert are skipped and the attempt is treated as a replayed used code (generic failure + lockout counter). Mirrors the passkey-rename CAS pattern in `osn/api/src/services/auth.ts` — see [[recovery-codes]]
- [ ] S-M1 (series) — `GET /series/:id/instances` leaks existence of private series (404 on missing id vs 200 `[]` on private unviewable). Align with [[event-access]] — return 200 `[]` when series exists-but-invisible (or 404 for both) — `pulse/api/src/routes/series.ts:149`, `pulse/api/src/services/series.ts:494`
- [ ] S-M1 (vid) — Unbounded presentation issuance / no rate limit on `POST /identity/presentation/issue`. Spec a per-(user, audience) limit (~10/hr) + global per-user cap before V-M4 — see [[verified-identity]], [[rate-limiting]]
- [ ] S-M2 (vid) — Selfie / biometric raw-image retention boundary owned by vendor, not OSN. Spec direct browser→vendor upload (signed URL or vendor SDK); `osn/api` only sees `runId` + redacted response. Add biometric to `redact.test.ts` denylist — block V-M1 — see [[verified-identity]]
- [ ] S-M3 (vid) — `presentations.requested_claims` / `released_claims` JSON unbounded in current schema spec. Constrain to bounded enum of attribute kinds, cap row size; mirror the bounded-enum rule for the `presentation.issued{claims}` metric — see [[verified-identity]]
- [ ] S-M4 (vid) — `verified_attributes.value` encryption-key custody underspecified. Move from "key in env" to envelope encryption (KEK in KMS, per-row DEK, AES-256-GCM, AAD = `account_id ‖ attribute_kind`). Document in [[compliance/data-map]]. Block V-M2 — see [[verified-identity]]
- [ ] S-M2 (series) — `listInstances` ignores the invited-RSVP branch in `canViewEvent` ([[event-access]]). Invited non-organiser viewers are wrongly 404'd on the private-series gate, and a single promoted-to-public instance leaks the parent series to anonymous callers. Replace inline visibility filter with per-row `canViewEvent` (or a parallel RSVP-join predicate) — `pulse/api/src/services/series.ts:500-502`
- [ ] S-M2 (cire) — Guest claim-code rate limiter on the Workers runtime is in-memory per-isolate, so a distributed guesser fans requests across isolates to multiply the effective ceiling. The global Workers rate-limit binding must be the load-bearing throttle in production — verify `wrangler.toml` wires the CF Rate-Limiting (or KV/Durable-Object) binding and that the code never silently falls back to the in-memory limiter when the binding is configured — see [[cire-auth]], [[rate-limiting]] (PR #116 review)
- [ ] S-M3 (cire) — **Accepted product decision.** (Not contradicted by AUDIT-C1: the `secure` code style and the shared rate-limit backend shipped; this row covers only the opt-in `simple` tier.) Simple-tier claim codes carry ~40 bits of entropy (6-char hash, `SURNAME-WORD-HASH`). Deliberately kept low for guest UX (a wedding household types it from a paper invite); the load-bearing defence is the global Workers rate limiter (see S-M2 cire), not code length. No change planned — documented here so the finding isn't re-raised — see [[cire-auth]] (PR #116 review)
- [x] S-M4 (cire) — **Fixed** — closed by AUDIT-C6; `cire/api/src/routes/account-link.ts:186-200` rotates the `cire_session` token inside the link transaction. Original finding: guest-session token rotation was not performed on the auth-state transition at `POST /api/account/link` (the additive guest-cookie ↔ OSN-account bind), leaving a residual session-fixation surface. Rotate the `cire_session` token inside the link transaction. Folds into AUDIT-C6 — see [[cire-auth]] (PR #116 review)

### Low

- [ ] S-L (jose-6.2.5-hardening, 2026-07-30 prep-pr security review) — **take `jose` 6.2.5 once it clears the 72h quarantine (eligible ~2026-08-01T23:05Z).** The 2026-07-30 dependency sweep took only 6.2.4, which is a docs update plus an inert `exportJWK` refactor. The JOSE/JWT **input-validation hardening lands in 6.2.5**: reject characters outside the Base64URL alphabet, reject invalid UTF-8 in JOSE headers and JWT claims sets, reject truncated ASN.1 key data, reject duplicate `crit` values, reject unencoded payloads in the JWS Compact Serialization, and compare claim values correctly for falsy validation options. `jose` sits under both ARC S2S tokens ([[arc-tokens]]) and the 5-minute `osn-access` JWTs ([[identity-model]]), so this is parser hardening on the two token types where it matters most. No advisory attaches to it, so it does **not** warrant a `minimumReleaseAgeExcludes` bypass — just take it on the next sweep. Note the tightening is strict: watch for tokens that were previously accepted and now aren't.
- [x] S-L103 (2026-07-30 prep-pr security review) — the dependency changeset credited `jose` **6.2.4** with validation hardening that actually ships in **6.2.5**, which the branch does not take. A false record here would have read as "the JWT parser hardening is in the tree" when it is not, so the real upgrade would never get scheduled. **Fixed on branch** — changeset corrected to describe 6.2.4 accurately, and the 6.2.5 upgrade is tracked as the item above.
- [x] S-L104 (2026-07-30 prep-pr security review) — S-L102's recorded rationale attributed the limited exposure to the call site's `attestationType: "none"`. `verifyRegistrationResponse` accepts no such argument: it dispatches on the `fmt` the *client* returns and reads anchors via `SettingsService.getRootCertificates({ identifier: fmt })`, so a client can return `fmt: "packed"` with an `x5c` regardless of what the RP requested. The conclusion was right but the stated mechanism was load-bearing and wrong, in a permanent security record. **Fixed on branch** — [[changelog/security-fixes]] now names the real invariant (no trust anchors are configured anywhere, so `validateCertificatePath` short-circuits on `trustAnchorsPEM.length === 0`) and flags that configuring root certificates or enabling `MetadataService` removes the precondition — see [[passkey-primary]].
- [ ] S-L (turnstile-token-fungibility, 2026-07-27 prep-pr security review) — `siteverify` in `shared/turnstile/src/index.ts` reads only `success` + `error-codes`, ignoring the `hostname` and `action` fields Cloudflare already returns. One widget/secret pair backs both the identity ceremonies on `musubi.social` and the unauthenticated cire guest claim form, so a token minted on the cheaper, fully public cire page is accepted by osn-api's register/login gate. Low: Cloudflare's own bot scoring and single-use redemption still apply, and the cire secret is unset today so that faucet is currently closed. Fix: assert `data.action === "turnstile-spin-v1"` and `data.hostname` against a per-caller allowlist, keeping the key-optional/fail-closed contract. **Pre-existing** — the shared widget already served OSN ceremonies via cire/organiser before the musubi move. See [[turnstile]].
- [x] S-L (esbuild-dev-read, 2026-07-21 dependency review) — **Resolved 2026-07-30.** Low advisory `GHSA-g7r4-m6w7-qqqr` (`esbuild >=0.27.3 <0.28.1`, arbitrary file read via the dev server on Windows). The documented drop-trigger — "raise the floor to `^0.28.1` once wrangler ships an esbuild ≥0.28.1 pin" — fired: **wrangler 4.114.0 pins `esbuild 0.28.1` exactly**, the fixed version. By then the root override `"esbuild": "^0.27.0"` had inverted from protective to harmful, clamping wrangler's own safe pin back down to the vulnerable 0.27.7. Raised the override to `^0.28.1`; astro already declared `^0.28.0`, so the floor now agrees with both consumers rather than fighting either. Whole tree resolves to a single `esbuild@0.28.1`, `bun audit` reports no vulnerabilities, and the full build (12/12) + suite (31/31) pass on it. Moved to [[changelog/security-fixes]].
- [ ] S-L (native-binding-scopes, 2026-07-21 prep-pr security review) — astro 7 swaps the pure-JS `@astrojs/markdown-remark` chain (~70 packages) for native-binary pipelines: `satteri` (pre-1.0) + `@bruits/satteri-*`, `@astrojs/compiler-rs` bindings, and `rolldown` + `@rolldown/binding-*` (via vite 8). Verified 2026-07-21: zero install scripts, npm integrity pins, wasm fallbacks, `minimumReleaseAge=3d` applies, and no site renders markdown so satteri is inert at runtime. Awareness only — fold these publisher scopes into the C-M7 CI dependency-scan when it lands. See [[compliance/soc2]].
- [ ] S-L3 (oidc, 2026-07-24 follow-up review of the OIDC provider) — `completeAuthorization` reads the parked request from the ceremony store and deletes it in two steps, so two same-browser concurrent decision POSTs for one request id could in principle both read it before either delete and mint two codes (sharing one `nonce`). Low: both codes belong to the same (account, client, scope), the binding cookie (S-M1 oidc, fixed) restricts the race to the originating browser, and codes stay single-use. Real fix is an atomic take-and-delete on the `CeremonyStore` contract (Redis `GETDEL`) — batch with the next store change. See [[oidc-provider]].
- [ ] S-L4 (oidc, 2026-07-24 prep-pr review of the hardening batch) — remove the mid-deploy tolerance branches one release after the batch ships: `bindingHash === undefined` passes the browser-binding check unconditionally, and `requireAuthAfter`/`maxAge` read as undefined mean "no demand" (`!= null` guards). Safe today — `parkRequest` always writes all three fields and pre-upgrade parked entries expire within 10 min of the deploy — but an optional field plus an unconditional-pass branch is a standing invitation for a future store writer to silently disable the binding. Make the three fields required on `PendingAuthorizeRequest` and delete the branches. See [[oidc-provider]].
- [ ] S-L2 (rotation-race-attribution, 2026-07-20 prep-pr security review of PR #289) — the new `osn.auth.session.rotation_race` counter (benign concurrent/retried refresh grants tolerated within `ROTATION_GRACE_MS`) has no per-account attribution, so a deliberate `/token` hammer with a rotated token (each attempt still fails closed) is indistinguishable from normal multi-tab usage in metrics. Not exploitable (no escalation — every such grant fails). Observability hardening only: alert on absolute `rotation_race` rate + the `family_revoked : rotation_race` ratio, and lean on existing per-IP/per-account `/token` rate limiting. Adding accountId/familyId attributes would violate bounded-cardinality + PII-redaction rules. See [[sessions]]. (S-L1 same review = accepted grace-window theft-signal tradeoff, documented in [[sessions]], no action.)
- [x] S-L (export-passkey-user-id, 2026-07-08 prep-pr review of C-H1) — `GET /account/export`'s `account` section emits `passkeyUserId`. **Decision: keep as spec'd** (2026-07-08). It matches the explicit `[[compliance/dsar]]` field list, is not a P6 violation (it is not `accountId`, and it is the owner's own data), and is an opaque WebAuthn user-handle rather than a cross-service identifier. Accepted-risk (data-minimisation nit, not a leak). `osn/api/src/services/account-export.ts`.
- [ ] S-L (export-profileids-crosscheck, 2026-07-08 prep-pr review of C-H1) — the Pulse/Zap `POST /internal/account-export` handlers query directly on the ARC-supplied `profile_ids` without cross-checking they belong to `account_id`. Not exploitable today (only osn holds the `account:export` scope and derives the IDs server-side), but a bug/compromise in osn that sent foreign `profile_ids` would leak another account's data with no downstream guardrail. Defence-in-depth: Pulse can intersect against `pulse_profile_accounts`; Zap has no such cache (document the trust assumption). See `[[arc-tokens]]`, `[[cire-auth]]`.
- [ ] S-L3 (pulse-ip-keying, 2026-07-03 quality review) — `pulse/api` still keys three per-IP limiters via the deprecated no-args `getClientIp(headers)` (left-most XFF / `"unknown"` bucket): `routes/venues.ts:78`, `routes/onboarding.ts:130,176`. Low severity (read-mostly public surfaces, in-memory limiters anyway) but should adopt the S-M34 `clientIpConfig` + `isUnresolvedIp`-deny pattern when the Pulse limiter backend moves to Redis/Workers bindings (S-L1 pulse-workers) — see [[rate-limiting]]
- [ ] S-L1 (landing) — CSP keeps `script-src 'self' 'unsafe-inline'` on `@osn/landing` + `@pulse/landing` `_headers` (required by Astro's island bootstrap + `is:inline` scripts; no first-party HTML sink today, so residual XSS risk is low). Harden to hashed/nonce-based CSP. See [[osn-landing]], [[pulse-landing]].
- [x] S-L2 (pulse-landing) — `/api/geo` returned per-visitor IP location with `Cache-Control: public`, so a shared proxy could cross-serve one visitor's coarse location to another. **Fixed** — changed to `private, max-age=300` (browser-only). See [[pulse-landing]].
- [x] S-L3 (landing-deploy) — `.github/workflows/deploy-osn-pulse-landing.yml` declared no `permissions:` block (inherited the default `GITHUB_TOKEN`). **Fixed** — added top-level `permissions: { contents: read }` (least privilege; deploy auth is the Cloudflare token, not `GITHUB_TOKEN`).
- [ ] S-L1 — Seed data uses reserved handle `"me"` — reservation not DB-enforced
- [ ] S-L2 — `Effect.orDie` in `requireAuth` swallows auth errors — replace with `Effect.either` + 401
- [ ] S-L2 (pulse-onboarding) — `_testKey?: CryptoKey` positional argument on `createOnboardingRoutes` (and 3 other Pulse route factories: `createCloseFriendsRoutes`, `createEventsRoutes`, `createSeriesRoutes`). A misuse where a non-test caller passes a key would bypass JWKS rotation + kid-binding. Defence-in-depth fix: gate `_testKey` honouring on `process.env.NODE_ENV === "test"` inside `extractClaims` so production bundles can never honour it. Pre-existing pattern, called out by the security review of this branch — track as a Pulse-wide cleanup — see [[pulse-onboarding]]
- [ ] S-L4 — `createdByAvatar` always null — no avatar claim in JWT
- [ ] S-L5 (account-deletion) — Adaptive AMR for `*_app_delete` purposes: when an account has at least one passkey, refuse OTP-only step-ups for app-deletion ceremonies. Today both flows accept passkey OR OTP via `recoveryGenerateAllowedAmr` — tighter posture available but conflicts with the "user with lost passkey can still leave" UX. Consider once recovery-flow UX matures — see [[passkey-primary]]
- [x] S-L6 (account-deletion) — **Fixed (2026-07-05)** — Pulse `requireArc` early-exit branches now record the shared `arc.token.verification` counter (malformed / `unknown_issuer` / new `revoked_key` / `scope_denied`); paths reaching `verifyArcToken` were already self-reported. See [[observability/overview]], [[changelog/security-fixes]]
- [ ] S-L7 (osn) — The five native rate-limit `namespace_id`s (2001–2005 in `osn/api/wrangler.toml`) are account-scoped and unverified against the live Cloudflare account. A collision with another Worker's namespace silently merges global counters (no deploy error). Confirm 2001–2005 are unused in the osn-api account at deploy (cire uses 1001; no in-repo collision) — see [[rate-limiting]], [[runbooks/production-deploy]] (ratelimit-hardening branch review)
- [ ] S-L8 (osn) — `[observability] head_sampling_rate = 1` in `osn/api/wrangler.toml` captures every Workers invocation. No PII concern today (redacting `osnLoggerLayer` unchanged, no client IP logged), but revisit the sampling rate once invocation volume grows for cost/retention — see [[observability/overview]] (ratelimit-hardening branch review)
- [ ] S-L3-follow-up (pulse) — Tauri CSP `connect-src` includes a transitional `https:` entry because production `@osn/api` + `@pulse/api` origins aren't pinned in-repo. Replace with the deployed origins once they land in env. See [[changelog/security-fixes]] entry "Pulse Tauri CSP allowlist (2026-04-25)"
- [x] S-L7 — `jwtSecret` falls back to `"dev-secret"` — **Superseded**: symmetric `OSN_JWT_SECRET` removed entirely; replaced by ES256 key pair (`OSN_JWT_PRIVATE_KEY`/`OSN_JWT_PUBLIC_KEY`); startup guard uses `OSN_ENV` — see [[arc-tokens]]
- [x] S-L29 — `/graph/internal/*` mounted under open CORS. **Fixed** — `cors()` now uses `OSN_CORS_ORIGIN`; local dev fallback = monorepo Tauri dev ports (`:1420`, `:1422`); wildcard removed; derivation extracted to `resolveCorsOrigins` (see `osn/api/src/lib/cors-config.ts`) — see `[[arc-tokens]]`
- [x] S-L1 (cors) — `resolveCorsOrigins` initially tied the local-dev fallback to `OSN_ENV`, so a non-local deploy missing both `OSN_ENV` and `OSN_CORS_ORIGIN` would silently pick up dev ports instead of failing closed. **Fixed** — fallback now gated on the same `cookieConfig.secure` signal used for cookie hardening; the S-L4 boot-time check covers both predicates.
- [x] S-L2 (cors) — `OSN_CORS_ORIGIN` entries matched browser `Origin` headers byte-for-byte, so `"HTTPS://App.Example.com/"` (trailing slash / mixed case) would reject legitimate requests and push ops toward widening the allowlist. **Fixed** — entries are lowercased and stripped of a single trailing slash in `resolveCorsOrigins`.
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
- [x] S-L101 — `registerWithOsnApi()` silently returned early when `INTERNAL_SERVICE_SECRET` unset. **Fixed** — throws in non-local envs (`OSN_ENV != "local"`) so misconfiguration is caught at boot; in local dev logs a warning and boots anyway to unblock developer workflows — see [[arc-tokens]]
- [x] S-M1 (auth) — ~~`pkceStore` unbounded + no expiry sweep~~ — **Obsolete**: `pkceStore` deleted with PKCE cleanup (Phase 5b)
- [x] S-M2 (auth) — ~~`/authorize` has no rate limiter~~ — **Obsolete**: `/authorize` route deleted with PKCE cleanup (Phase 5b)
- [x] S-M4 (auth) — **Fixed (2026-07-05)** — `loadJwtKeyPair` asserts `privateKey.usages.includes("sign")` after import; a public JWK pasted into the private slot now fails at boot instead of on the first token mint. See [[changelog/security-fixes]]
- [ ] S-L4 (auth) — `logDevOtp` (`osn/api/src/services/auth/helpers.ts`) interpolates recipient email + OTP code into a free-text `Effect.logDebug` message, bypassing the annotation-key-based redaction deny-list (`shared/observability/src/logger/redact.ts`). Only fires when `OSN_ENV` is unset/`"local"` (fail-closed env gate verified), so no leak in any deployed env — defence-in-depth note only. If hardening: drop the email from the line (operator already knows the address) — see [[email]], [[observability/overview]]
- [x] S-L5 (auth) — **Fixed (2026-07-05)** — `buildAppDeps` throws when `OSN_ENV` is non-local and `OSN_ORIGIN` is unset, mirroring `assertCorsOriginsConfigured`; all deployed wrangler tiers already set it. See [[passkey-primary]], [[changelog/security-fixes]]
- [ ] S-L2 (auth) — Wildcard CORS on `@pulse/api` — restrict to known client origins (mirrors OSN_CORS_ORIGIN pattern) — see [[rate-limiting]]
- [ ] S-L22 — `listRsvps` counts privacy-filtered rows toward `limit` (weak side-channel oracle)
- [x] S-L23 — ~~`pkceStore` has no size bound or eviction sweep~~ — **Obsolete**: `pkceStore` deleted
- [ ] S-L24 — `/token` and legacy `POST /register` have no rate limiting (partial: `authorization_code` grant deleted; `refresh_token` grant and legacy `POST /register` still unthrottled)
- [ ] S-L30 — `createInternalGraphRoutes` has no `loggerLayer` — see [[arc-tokens]], [[observability/overview]]
- [x] S-L1 (zap) — `jwtVerify` did not restrict algorithms (HS256 shared secret). **Fixed** — token verification migrated to ES256/JWKS via `@shared/osn-auth-client` (`extractClaims`, `algorithms: ["ES256"]` + `audience: "osn-access"` enforced in-pass); `OSN_JWT_SECRET` removed; non-local plaintext-JWKS boot guard added; AUDIT-Z2 chokepoint rejects non-`usr_` subs — see [[apps/zap]], [[identity-model]]
- [x] S-L2 (zap) — DM chats had no member count enforcement. **Fixed** — `createChat`/`addMember` enforce DM = exactly two members (`InvalidDmMembership`) — see [[apps/zap]]
- [x] S-L3 (zap) — Admin could remove themselves leaving chat with no admin. **Fixed** — `removeMember` rejects removing the last remaining admin (`LastAdmin`, 409) — see [[apps/zap]]
- [x] S-L1 (passkey) — `PasskeysView` `window.confirm` race could swap pending delete id on rapid double-click. **Fixed** — every Rename / Delete button is disabled while a step-up ceremony is in flight (`locked()`); pending action stored as a single tagged signal — see [[identity-model]]
- [x] S-L2 (passkey) — `listPasskeys` exposed raw `credentialId` to the browser without UI need. **Fixed** — projection drops `credentialId`; opaque `pk_<hex>` `id` is the only handle reaching the client — see [[identity-model]]
- [x] S-L3 (passkey) — Fallback "no caller session" branch in `deletePasskey` nuked all sessions silently. **Fixed** — branch now `Effect.logWarning`s the anomalous condition before the wipe — see [[sessions]]. Narrowed again 2026-07-26 by the `osn_sid` binding: reached only when there is no cookie **and** no live session matching the access token's binding (S-M1 passkey-cookieless-revocation).
- [x] S-L4 (passkey) — `DELETE /passkeys/:id` accepted OTP step-up via reused `recoveryGenerateAllowedAmr`. **Fixed** — new `passkeyDeleteAllowedAmr` config knob defaults to `["webauthn"]` (passkey-only); operators can widen if their threat model requires — see [[step-up]]
- [x] S-L5 (passkey) — `verifyPasskeyAssertion` reflected raw `@simplewebauthn/server` error text to the client (verifier-probe oracle). **Fixed** — fixed `"Passkey verification failed"` on the wire; cause logged via `Effect.logWarning` — see [[identity-model]]
- [ ] S-L1 (org) — Org creation rate limit (60/min) shared with member ops
- [ ] S-L3 (org) — TOCTOU gap in handle uniqueness check
- [ ] S-L1 (social) — Access tokens in `localStorage` via `StorageLive` — XSS = token exfiltration. Inherited from `@osn/client`; revisit alongside S-M20 by moving to HttpOnly cookie BFF or `sessionStorage` with tight TTL — see [[identity-model]]
- [ ] S-L4 (recs) — `mutualCount` discloses graph-inference signal; adversary with many test accounts can combine counts to deduce third-party connection sets. Consider bucketing (e.g. "10+") above a threshold — see [[social-graph]]
- [ ] S-L1 (auth-fetch) — `OsnAuthService.authFetch` attaches `Authorization: Bearer` + `credentials: include` to any URL; no origin allowlist. Add `allowedOrigins` to `OsnAuthConfig` and skip header attachment off-list (defence-in-depth against mis-routed fetches / injected URLs) — see [[identity-model]]
- [ ] S-L2 (security-events) — `notifyRecovery` logs a stable `"notify_dispatch_failed"` message, but if `AuthError.message` ever embeds the mailer-provider response body a future refactor could leak the recipient email past the key-based redactor. Pin the log message shape with a test and assert the raw cause only appears on the span — see [[recovery-codes]]
- [ ] S-L3 (security-events) — `securityEventList` + `securityEventAck` limiters are keyed per-IP via `getClientIp` (`osn/api/src/routes/auth/`), but both endpoints are authenticated. Key by `claims.profileId` to strengthen the CGNAT / botnet-fan-out threat model (same pattern as `/recommendations/connections`) — see [[rate-limiting]]
- [ ] S-L1 (series) — No rate limit on `POST /series`, `PATCH /series/:id`, `DELETE /series/:id`. Each POST materialises up to 260 rows. Add per-user limits (e.g. 10/hour create, 60/hour patch) — see [[rate-limiting]]
- [ ] S-L1 (vid) — `DELETE /identity/attributes/:kind` revokes locally but outstanding SD-JWT VCs minted from that attribute remain cryptographically valid until expiry. Add an OAuth Status List endpoint at `/.well-known/`; require verifiers to consult it; document TTL trade-off — see [[verified-identity]]
- [ ] S-L2 (vid) — Threat-model snapshot in [[verified-identity]] is missing: holder device compromise (stolen session can mint presentations — call out step-up gating explicitly), issuer-side internal abuse (`@osn/api` operator silently minting VCs without user consent → `admin_actions` audit, ties to C-M16), `nonce`/`jti` clock skew + replay window, and downgrade attacks where an RP requests `age_band` instead of `age_over_18` to learn more than needed (consent UX should warn on over-broad asks). Expand before V-M0 STRIDE pass
- [ ] S-L3 (vid) — `verification_runs.failure_reason` and "redacted provider response" are undefined. Spec a vendor-response-redactor module with explicit allowlist (status, score, run id, error code) and denylist for everything else; mirror [[observability/overview]] redaction pattern — see [[verified-identity]]
- [ ] S-L2 (series) — `expandRRule` safety valve (`weekIdx > 10_000`) permits ~70k `Date` allocations when `UNTIL < dtstart`. Reject `UNTIL < dtstart` in `parseRRule` and lower the valve to ~520 weeks / 120 months — `pulse/api/src/services/series.ts:187-237`
- [ ] T-M (series) — Coverage gaps from review: `listInstances` `scope: "all"`; `updateSeries` `this_and_following` with/without `from`; `parseRRule` happy paths for `UNTIL`/`INTERVAL`/`BYDAY`; `expandRRule` `UNTIL` + `BYDAY` fanout; `materializeInstances` `extend_window` trigger; `GET /series/:id` 200 happy path + private-visibility 404 masking; `PATCH /series/:id` 200/422/404 paths
- [ ] S-L1 (pulse-close-friends) — `POST /close-friends/:friendId` is unrate-limited and the 422-vs-201 distinction makes it a connection-existence oracle. Caller can only probe their own connections (already enumerable via OSN `/graph/connections`), but the asymmetry bypasses OSN's 60/min limit. Defer to a Pulse-wide rate-limiter when one lands; mirror the OSN `GRAPH_RATE_LIMIT_MAX` (60/min/user) — see [[rate-limiting]], [[pulse-close-friends]]
- [ ] S-L2 (pulse-close-friends) — Cross-DB hygiene: `pulse_close_friends.friendId` references an OSN profile but Pulse has no S2S notification or reconciliation hook for OSN profile deletion. Stale rows render as ghost entries (null handle/displayName) on the close-friends page. Add an internal Pulse endpoint OSN can ARC-call post-deletion, or a periodic reconciliation job — see [[pulse-close-friends]], [[s2s-patterns]]
- [ ] S-L1 (cire) — Verify `ORGANISER_TOKEN` is not set as a CF secret on the deployed cire-api worker; the `X-Organiser-Token` auth path is deleted from code, but a secret set during the interim would linger as stale config. If present: `wrangler secret delete ORGANISER_TOKEN` (manual, from `cire/api`) — see [[cire-auth]]
- [x] S-L3 (cire) — **Fixed** — closed by AUDIT-C5; `cire/api/src/lib/origin-guard.ts` (+ `origin-guard.test.ts`) is wired in `app.ts`. Original finding: no Origin-header validation on cire's state-changing routes (`POST /api/claim`, `/api/rsvp`). Relies solely on `SameSite=Lax` for CSRF defence; OSN convention (origin-guard M1) additionally rejects POST/PUT/PATCH/DELETE whose `Origin` is present and not in the CORS allowlist. Apply the origin-guard equivalent on cire/api — see [[cire-auth]], `osn/api/src/lib/origin-guard.ts`
- [ ] S-L1 (cire-landing) — CSP on the static marketing site (`cire/landing/public/_headers`) allows `script-src 'self' 'unsafe-inline'` (needed by Astro's island bootstrap + the `is:inline` reveal/font scripts). No active vector today — the site is fully static with no user-reflected content — but move to nonce/hash-based `script-src` and drop `'unsafe-inline'` once Astro's inline bootstrap is hashable. Fold into the apex cutover. See [[cire-landing]]
- [ ] S-L2 (cire-landing) — Hotlinked third-party origins (`images.unsplash.com`, `fonts.googleapis.com`/`fonts.gstatic.com`) receive visitor IP/UA; passive subresources (no code-exec), CSP-allowlisted. Privacy/ePrivacy concern, not a code flaw: before the apex flips to real traffic, self-host fonts + proxy/self-host imagery and list Unsplash + Google Fonts in [[subprocessors]]. See [[cire-landing]]
- [ ] S-L1 (db-dev-tooling) — `scripts/cire-db-seed.sh` interpolates `CIRE_DEV_OWNER_PROFILE_ID` directly into a SQL `UPDATE` string (string-breakout shape). Bounded: developer-supplied env var, executed against a `--local` miniflare D1 only — not an exploitable vector, but the wrong pattern to copy. Parameterise via `wrangler d1 execute --param` (the equivalent re-point in `cire/api/src/local.ts` already uses Drizzle binding correctly) — see [[cire-auth]]
- [x] S-L2 (share-attribution) — **Fixed** — closed by AUDIT-S1/S-M34; `getClientIp` now takes a resolution mode and fails closed, and no share/exposure route calls the deprecated no-args form (`pulse/api/src/routes/events.ts:245` passes `clientIpConfig`). The three remaining no-args call sites are tracked separately as **S-L3 (pulse-ip-keying)**. Original finding: shared `"unknown"` bucket. When `x-forwarded-for` is absent, `shared/rate-limit/src/index.ts` keys everyone under the literal `"unknown"`, collapsing the per-IP guarantee that the share/exposure (60/120 req/min) limits depend on. Pre-existing helper, but the new unauthenticated `pulse.events.share.invoked` / `pulse.events.share.exposure` counters are the most sensitive consumers. Fold into the planned Redis-backed limiter so per-IP buckets can pull from the connection address — see [[rate-limiting]]
- [ ] S-L4 (zap) — On the Cloudflare Workers runtime the per-IP write limiters use in-memory counters scoped to a single isolate (`zap/api/src/index.ts buildApp` → `createDefaultZapRateLimiters`), so the effective ceiling multiplies with isolate count. The IP key is now spoof-safe (S-H1 fixed) but the bucket store is not yet distributed. Move to a durable backend (CF Rate-Limiting binding / KV / Durable Object) before relying on Zap limits as a hard throttle in prod — see [[rate-limiting]] (PR #116 review)
- [ ] S-L1 (pulse-workers) — Same per-isolate limiter caveat for the Pulse Worker (`pulse/api/src/index.ts buildApp` uses `makeMemoryRateLimiters()`); the long-lived `local` host wires Redis via `REDIS_URL`, but the Worker path has no distributed store yet. Per-user write limits + per-IP share/exposure limits are per-isolate on `dev`/`staging`/`prod`. Wire a durable backend before the Worker deploy is the load-bearing path — see [[rate-limiting]], [[redis]] (PR #116 review)
- [x] S-L1 (deps-audit) — **Resolved (#214 dependency sweep + audit-gate retighten).** The pre-push `bun audit` gate in `lefthook.yml` previously carried `--ignore` entries accepting known `high` advisories in dev/test-only transitive deps. All are now fixed at source via root `overrides` (#214): `GHSA-96hv-2xvq-fx4p` (ws → ≥8.21.0), `GHSA-fx2h-pf6j-xcff` (vite → ≥7.3.5), plus the earlier `GHSA-77vg-94rm-hx3p` (devalue) and `GHSA-gv7w-rqvm-qjhr` (esbuild). The last two `--ignore` flags (ws, vite) were dropped and the gate is back to a clean `bun audit --audit-level=high` with **zero** ignores — `bun audit` reports no vulnerabilities. The convention for accepting a genuinely-unreachable NEW advisory is documented inline in `lefthook.yml`. Moved to [[changelog/security-fixes]].
- [x] T-S1 (cire) — _done (platform PR 0)_: `cire/api/src/db/ddl-lockstep.test.ts` applies `cire/db/migrations/*.sql` (filename order — what `wrangler d1 migrations apply` actually uses; the drizzle-kit journal stopped at 0008) to one in-memory DB, the `setup.ts` DDL to another, and diffs a normalised structural snapshot (columns, FKs, indexes, checks); the Drizzle schema is introspected via `getTableConfig` and diffed too, so all THREE mirror surfaces are pinned. Surfaced + fixed four real setup.ts drifts (fabricated `DEFAULT ''` on `events.start_at/end_at/timezone`, missing `guest_events_event_id_idx`, stale single-column guests index, invented `rsvps.status` CHECK) and deleted the fourth mini-mirror DDL in `schema.test.ts`. Unblocks the Phase 0 `families` rebuild — see `cire/wiki/todo/platform.md`
- [ ] T-S2 (cire) — `weddingsService.listForOwner` has no co-located unit test (only route-level coverage); add `services/weddings.test.ts` asserting oldest-first ordering, the one behaviour route tests don't pin
- [ ] T-x (hardening-sweep, 2026-07-05 prep-pr review) — deferred test gaps from the review of the hardening-sweep PR (T-M1/T-U1/T-U2 were fixed in-PR): **T-U3** assert `metricEventCreateDuration` emission (ok/error) via spy in `pulse/api/tests/services/events.test.ts`; **T-E1** assert `metricPulseHostCancelledHardDelete` ok + error paths in `runEventCancellationSweep` (error branch has never executed in a test); **T-S1** positive test that a `graph:resolve-account`-ONLY token passes `/profile-account` and 401s on a `graph:read` route; **T-S2** local-env complement for the S-L5 `OSN_ORIGIN` boot guard (no-throw + localhost fallback)
- [ ] T-M2 (cire) — `cire/organiser` ships the OSN sign-in flow with zero tests (workspace `test` script is still the `echo 'No tests yet'` stub). Add vitest + unit-test `isAuthExpired` (tagged `AuthExpiredError`, Effect FiberFailure string form, unrelated error) — its string-match fallback is fragile and a misclassification means redirect loops or a dead dashboard on token expiry. Mirror `cire/web`'s vitest setup
- [x] IB-S-M1 (cire) — _fixed PR #112_: added `X-Content-Type-Options: nosniff` to the invite image-serve `Response` (served type already derives from the upload-time magic-byte allowlist). See `cire/wiki/todo/security.md`, [[cire-auth]]
- [x] IB-S-L1 (cire) — _fixed PR #112_: per-IP rate limiter (30 req/min, overridable) on the organiser invite instance, ahead of auth; 429 test added. See `cire/wiki/todo/security.md`, [[rate-limiting]]
- [x] IB-S-L2 (cire) — _done `feat/cire-assets-reconcile`_: both R2-orphan paths now closed. The retention sweep reaps `cire-sheets` CSVs (`feat/cire-retention-r2-sweep`), and a new daily scheduled **`cire-assets` orphan reconciliation** (`services/asset-reconcile.ts`) deletes invite-image objects under `assets/` referenced by no live `wedding_invite_customisations`/`events` row, with hard fail-safe guards (abort-on-uncertainty: a failed or empty referenced-key read against a non-empty bucket deletes nothing; 7-day grace window; prefix scoping; per-run cap; best-effort deletes). Folds into C-H1 (account-export still open). See `cire/wiki/todo/security.md`

### Recovery / passkey-primary (Phase 5 prerequisites)
- [x] M-PK1b — Out-of-band recovery-code regeneration + consumption notification. `security_events` audit table covers both recovery code kinds; `/account/security-events[/:id/ack | /ack-all]` routes require step-up (S-M1) and the Settings banner uses optimistic local removal (P-I3). **Shipped** — see [[recovery-codes]] and `[[changelog/completed-features]]`
- [x] **M-PK** — Passkey-primary login (2026-04-22). OTP/magic-link primary login removed. `enrollmentToken` JWT machinery deleted — `/passkey/register/*` now authenticates via the normal access token issued by `/register/complete`. Registration is WebAuthn-gated (no flow without a supported browser) and enrollment is mandatory (no "skip" button). WebAuthn registration options: `residentKey: "preferred"` + `userVerification: "required"` — admits FIDO2 keys with PIN/biometric, rejects obsolete UP-only U2F. `deletePasskey` refuses **unconditionally** if it would leave 0 passkeys — account-level invariant "every live account has ≥1 WebAuthn credential" cradle-to-grave. Hardenings from the security review: **S-H1** step-up gate on `/passkey/register/*` when ≥1 passkey + `security_events{passkey_register}` audit row + email notification + server-derived session token; **S-H2** options/verifier UV alignment; **S-M1** uniform `/login/passkey/begin` response closing the enumeration oracle; **S-M2** `aud: "osn-access"` pinned on access tokens. See `[[passkey-primary]]`.

---

## Performance Backlog

Open findings only. Completed fixes move to [[changelog/performance-fixes]].

### Warning

- [ ] P-W (otel-line-lockstep, 2026-07-30 prep-pr performance review) — **take the whole OTel line to 0.221.0 + 2.10.0 together once the exporters clear the 14-day minor window (eligible 2026-08-04).** The 2026-07-30 sweep moved `@opentelemetry/{resources,sdk-metrics,sdk-trace-base,sdk-trace-node}` within-range to 2.10.0 while `exporter-{trace,metrics,logs}-otlp-http` + `sdk-logs` stayed at `^0.220.0`, which pin `core`/`resources`/`sdk-metrics`/`sdk-trace` to **exactly 2.9.0** — so the tree carried both lines at once, with the 2.10.0 packages linked against `core@2.9.0` (held there by the root `@opentelemetry/core` override) despite declaring an exact `core@2.10.0` dep. Measured cost on the Bun path was ~840 KiB / ~500 extra modules at boot for `pulse/api` + `zap/api`; production was unaffected because neither deployed Worker bundles any `@opentelemetry/*` SDK (`osn/api/src/observability.ts` uses only `/config` + `/logger`; `cire/api` adds `/fetch`, reaching only `@opentelemetry/api`). **Mitigated on branch** by holding the four SDK packages at `~2.9.0` (tilde, not caret — `^2.9.0` still admits 2.10.0), restoring the uniform 2.9.0 tree `main` had. When taking the upgrade: move all eight packages plus the root `@opentelemetry/core` override to the 2.10.0 line in one commit, and restore carets. OTel ships these in lockstep with exact intra-package pins for exactly this reason — see [[observability/overview]].
- [ ] P-I (ioredis-bun-tracing, 2026-07-30 prep-pr performance review) — informational, no action. ioredis 5.11 wraps every command in a `TracingChannel` guarded by `channel.hasSubscribers !== false`. Node returns `false` with no subscribers so tracing is skipped; **Bun 1.3.11 does not implement `hasSubscribers`**, so it is `undefined`, the guard passes, and every command runs `tracePromise` + `_buildCommandContext()` (regex `sanitizeArgs` + per-arg `String()`) with nothing listening. Measured ~0.65 µs/command on Bun vs ~0.22 µs on Node — under 0.5% of a 0.2–1 ms Redis round trip, and off the production path entirely since both deployed Workers select `createUpstashClient` over REST (`osn/api/src/redis.ts:134`) and `@shared/redis/ioredis` is reachable only from Bun composition roots. Recorded so the cause is known if `pulse/api` or `zap/api` is ever deployed on Bun against a real Redis; mitigation would be to run those on Node or pin `~5.10` for them — see [[redis]], [[rate-limiting]].
- [ ] P-W1 (cire-web-worker-size, 2026-07-21 astro 7 prep-pr review) — the `cire/web` SSR Worker bundle grew **289 KB → 428 KB gzip (+48%)** under astro 7/rolldown (measured main vs branch). Two causes: (a) ~187 KB raw of `motion` is newly server-bundled (astro 6/rollup emitted zero server-side motion bytes; reachable via dynamic `import()` from the `_slug_` route chunk) — audit the motion-consuming islands (`InvitePage.tsx`, `AnimatedModal.tsx`, `MapPreview.tsx`) for `client:only="solid-js"` or a server-side motion stub, restoring ~187 KB; (b) ~355 KB is rolldown emitting less compact chunks than rollup+esbuild (upstream, likely improves in point releases). Still far under the 3 MB Free-tier cap but a bad trajectory — also add a `dist/server` size threshold check to deploy.yml so toolchain bumps can't silently regress the Worker. Build times halved as the offsetting win (20.5 s → 7.7 s). See [[free-tier-limits]], [[cire]].
- [ ] P-W2 (otel-sdk-trace-consolidation, 2026-07-21 astro 7 prep-pr review) — OTel 0.220.0's exporters moved to the new consolidated `@opentelemetry/sdk-trace@2.9.0` package while `@shared/observability` still imports `sdk-trace-base`. The mixed-copy graph the review found was collapsed on-branch (core/sdk-trace-base/sdk-trace-node/resources/sdk-metrics all single-copy 2.9.0; root `@opentelemetry/core` override raised `^2.8.0 → ^2.9.0`), but both `sdk-trace-base@2.9.0` **and** `sdk-trace@2.9.0` remain resident on the Bun/Node path (deployed Workers unaffected — they import only logger/config/metrics subpaths). Follow-up: migrate `shared/observability/src/tracing/layer.ts` from `sdk-trace-base` to `sdk-trace` (the direction upstream signals — sdk-node deprecated its re-exports in 0.220) once `@effect/opentelemetry` peers on it. See [[observability/overview]].
- [ ] P-W6 (export-fanout-buffering, 2026-07-08 prep-pr review of C-H1) — the osn export streams with keyset pagination + a byte `ReadableStream`, but the downstream `POST /internal/account-export` handlers (`pulse/api/src/services/accountExport.ts`, `zap/api/src/routes/internal.ts`) query `WHERE profileId IN (...)` with **no LIMIT** and materialise the whole NDJSON body in one string before returning — undoing the streaming design at the weakest link (a 128 MB Cloudflare Worker). Bounded per-request by the 1/24h cap, but a pathological account (tens of thousands of RSVPs/events) can OOM the downstream. Fix: keyset-paginate the downstream queries (indexes already exist: `event_rsvps_profile_idx`, `events_created_by_profile_id_idx`, `chat_members_profile_idx`) and stream the sub-bundle via `ReadableStream`. See `[[compliance/dsar]]`.
- [ ] P-I (export-connections-keyset, 2026-07-08 prep-pr review of C-H1) — the `connections` export section pages with `WHERE (requesterId IN ids OR addresseeId IN ids) AND id > cursor ORDER BY id`; the single-column indexes let SQLite union the `OR` but it must then sort each page by `id`, so the keyset benefit is partially lost. Per-user, 1/24h-gated → Info only. Escape hatch: two separately-keyset-paginated passes each ordered by the indexed column, or `(requesterId,id)`/`(addresseeId,id)` composite indexes. `osn/api/src/services/account-export.ts`.
- [ ] ZC-P-W2 (zap c2b, 2026-07-19 PR-A prep-pr) — `sendC2bMessage` + `provisionC2bChat` (`zap/api/src/services/{messages,chats}.ts`) each do a post-write read-back (`getChat`/re-`SELECT`) → 3–4 sequential D1 round-trips per c2b write, on the enquiry hot path. Mirrors the existing `createChat`/`sendMessage` convention (left as-is for PR A); could construct+return from the known insert values (or `.returning()` when D1 supports it). The new c2b-body DSAR export got a `LIMIT 5000` cap on-branch (P-W1, e4185841); the keyset-streaming fix in **P-W6** now also applies to the c2b-body path (`loadC2bMessages`).
- [ ] ZC-P-I1 (zap c2b, 2026-07-19 PR-A prep-pr) — `chats_class_idx` indexes a 2-value skewed enum (`c2c`≫`c2b`); planner likely full-scans anyway while paying write amplification. Confirm via `EXPLAIN QUERY PLAN` or switch to a partial `WHERE class='c2b'` index (membership queries already join via `chatMembers`). Info.
- [ ] ZC-P-I2 (zap c2b, 2026-07-19 PR-A prep-pr) — `listC2bMessages` silently falls back to page 1 on an unknown `before` cursor, unlike `listMessages` (which `ValidationError`s). Trusted-service internal read, but aligning the cursor contract avoids caller re-pagination loops. Info.
- [ ] CL-P-W1 (cire-landing seal, 2026-07-22 wax-seal prep-pr) — residual mount-time cost of `mountWaxSeal` (`cire/landing/src/components/waxSealScene.ts`): geometry deform + normals + two 512² canvas paints still run as one synchronous task inside the idle callback. Largely mitigated on-branch (mesh 19k→7k verts, `pour.spread` cached, shader compile moved to `compileAsync`), so the remaining task is small — chunk the phases across idle slices only if hero INP ever flags in the field. See [[cire-landing]].
- [x] P-W1 (osn-landing) — `ConstellationCanvas` sized its backing store to the full document height × dpr (≈100 MB on a long page) and cleared+repainted it at ~60 fps forever, on every page. **Fixed** — the layer is now `position: fixed` and the canvas is sized to the viewport (a few MB regardless of page length), and the rAF loop pauses on `visibilitychange`. See [[osn-landing]].
- [x] P-W2 (pulse-landing) — `PulseField`'s rAF `tick` re-ran `querySelectorAll` + allocated ~300 `toFixed` strings every frame (the dot/ring set only changes on resize). **Fixed** — the SVG elements + parsed speed/phase are cached after `regen()` and reused each frame; no per-frame DOM walk. See [[pulse-landing]].
- [x] P-W5 (zap) — `createChat` checked OSN social-graph consent for every initial member in a sequential `for` loop (one S2S round-trip per member, up to `MAX_CHAT_MEMBERS`), serialising a large group create. **Fixed (PR #116 review, labelled P-W1 in the review)** — replaced with bounded-concurrency `Effect.forEach(initialMembers, (t) => checkConsent(creator, t), { concurrency: 10, discard: true })` so the round-trips overlap; any rejection still short-circuits (fail-closed, no half-built chat) — `zap/api/src/services/chats.ts`
- [ ] P-W3 (zap) — `provisionEventChat` non-atomic cross-DB writes
- [ ] P-I2 (zap-cursor) — `listChats` cursor resolution is a second round-trip (caller-scoped lookup, then the page query). Accepted in the 2026-07-03 audit review to keep the unknown/foreign-cursor 422 contract simple; fold the lookup into the page statement as a correlated subquery if zap list QPS ever matters — `zap/api/src/services/chats.ts`
- [ ] P-I3 (zap-sort) — `listChats` sorts the caller's entire chat set per page (`USE TEMP B-TREE FOR ORDER BY` — join-keyed sort can't be index-served). Bounded by per-user membership count; escape hatch if traces ever show it: denormalise `created_at` onto `chat_members` so `(profile_id, created_at DESC)` serves filter + order — `zap/api/src/services/chats.ts`
- [ ] P-I1 (erasure-sweep, 2026-07-05 prep-pr review) — `runEventCancellationSweep` deletes ready events one-at-a-time (up to 100 sequential `commitBatch` round-trips of 4 single-id DELETEs on D1). Background sweeper with a bounded batch, so Info-only; if sweep runtime ever matters, collect `ready.map(r => r.id)` into one `commitBatch` of 4 `inArray` deletes + record the hard-delete counter once via a batch `add(count)` (the `metricEventStatusTransitionBatch` precedent) — `pulse/api/src/services/accountErasure.ts`
- [ ] P-I5 (pulse-write-on-read) — list GETs (incl. the anonymous venue-events surface) can still persist status transitions — now batched to ≤ a handful of statements per request (2026-07-03 sweep), but reads-that-write serialise on SQLite's single writer and block a future read-replica split. Follow-up shape: derive status read-only at query time + background sweep — see [[event-access]], [[venues]]
- [ ] P-I1 (pulse-discovery) — cursor `(start_time, id)` ordering relies on the single-column `events_start_time_idx` for the tiebreak; cheap to add a compound index if series materialisation produces same-second collisions at scale — see `[[event-access]]`
- [ ] P-I1 (pulse-onboarding) — `getOnboardingStatus` re-validates the JSON `interests` column on every read (defensive walk through `INTEREST_CATEGORIES`) even though `Schema.decodeUnknown(CompleteOnboardingSchema)` already enforced membership at write time. Sub-millisecond cost; flagged purely as Info — only worth changing if profiling later shows it. See [[pulse-onboarding]]
- [x] P-W2 — `resolvePublicKey` hits DB when `tokenScopes` provided even if `kid` cache is warm. **Fixed** — cache entry now stores `CryptoKey` + `allowedScopes`; scope validated from cache on hit, no DB round-trip — see [[arc-tokens]]
- [x] P-W100 — `publicKeyCache` unbounded under key rotation churn. **Fixed** — `MAX_CACHE_SIZE` cap with oldest-entry eviction on write — see [[arc-tokens]]
- [x] P-W101 — `peekClaims` decoded payload before checking header validity. **Fixed** — header decoded first; payload decode gated on `kid` present — see [[arc-tokens]]
- [x] P-W102 — `evictExpiredTokens` O(n) scan on every `getOrCreateArcToken` call. **Fixed** — internal debounced sweep (`maybeSweepExpiredTokens`) runs at most once per 30 s; public `evictExpiredTokens` still sweeps immediately — see [[arc-tokens]]
- [x] P-W1 (session) — `trackRotatedSession` swept in-memory Map O(n) on every refresh. **Fixed** — Redis-backed store uses native PX TTL per key; in-memory fallback keeps the existing O(1) amortised FIFO sweep bounded by `ROTATED_SESSIONS_MAX` — see [[sessions]]
- [ ] P-W2 (session) — S-H1 migration adds extra `findProfileById` DB round-trip on every profile endpoint. Embed `accountId` in access token or add profileId→accountId cache — see [[identity-model]]
- [ ] P-W3 (jwks) — `extractClaims` in pulse/api serialises JWKS resolve before DB I/O on read-only routes — parallelise with `Promise.all` for anonymous-capable endpoints — see [[arc-tokens]]
- [ ] P-I4 (auth) — `/login/magic/verify` has no rate limiter — add `magicVerify: RateLimiterBackend` (10/60s per-IP, mirror `/login/otp/complete`). Pre-existing, not a regression; parity with the rest of `/login/*` — see [[rate-limiting]]
- [ ] P-I2 (cire-authz-gate, 2026-07-12 prep-pr review of cire roles) — `hostsService.authorize` resolves the per-request organiser gate (`weddingMember`/`weddingEditor`/`weddingOwner` all funnel through it) as two sequential D1 round-trips: a `weddings` owner lookup then a `wedding_hosts` seat probe. Pre-existing on main (the roles branch only added `role` to the selected columns). Collapse to one `weddings LEFT JOIN wedding_hosts` query keyed on `(wedding_id, osn_profile_id)` — same three-way outcome (missing / owner / role-or-null), halves the fixed gate tax on every organiser request — see [[cire-auth]]
- [x] P-I3 (cire) — **fixed in cire platform PR 3 (portal IA shell, 2026-07-15).** `GuestTable` over-fetched the full `/events` payload only to build an id→name chip map, and the `<Show>`-mounted tables refired both guests + events fetches on every tab switch. Both fetches are now lifted to module-scoped, weddingId-keyed caches: the existing `cire/organiser/src/lib/events-store.ts` plus a new sibling `guests-store.ts`. `GuestTable` reads guests from the guest store (fetched once per wedding, deduped across the new module shell's Guests ↔ Schedule remounts) and reads the chip map from the shared events cache — the duplicate `/events` fetch is gone. `ImportPanel`'s apply invalidates both. (The old `DashboardTabs` referenced here was itself replaced by `ModuleShell` in the same PR.) See [[cire]]
- [x] IB-P-W1 (cire) — _fixed PR #112_: `index.astro` resolves the customisation at build time and passes it to `InviteHeader` as `initial`, so hero copy + `<img src>` are in the SSR'd HTML; island revalidates on mount. See `cire/wiki/todo/perf.md`
- [x] IB-P-W2 (cire) — _fixed PR #112_: `index.astro` emits `<link rel="preload" as="image">` for the build-resolved hero image. See `cire/wiki/todo/perf.md`
- [x] IB-P-W3 (cire) — _fixed PR #112_: `getForWeddingId` collapsed into one `weddings LEFT JOIN wedding_invite_customisations`; `imageKeyForSlug` likewise (IB-P-I1). See `cire/wiki/todo/perf.md`
- [ ] P-I17 (venues) — a venue page view re-reads the venue row up to 3× (detail route, inside `listVenueEvents`, lineup gate) and the client lineup fetch waits on venue + events (two-hop waterfall). Consider joining the lineup gate's event check to the venue row and embedding the featured event's lineup in the `/events` response (`?include=featured_lineup`) to drop the serial RTT — see [[venues]]
- [ ] P-W22 — Two `Effect.runPromise` calls per internal graph request — consolidate when S2S throughput grows — see [[arc-tokens]]
- [x] P-W25 — `publicKeyCache` uses FIFO eviction; upgrade to LRU so the most-recently-used keys are kept under churn. **Fixed** — side-timestamp map (`publicKeyLastAccess`) records last-access in ms; O(1) touch on hit, O(n) scan only at eviction (DB-miss path) — see [[arc-tokens]]
- [x] P-W26 — `publicKeyCache` hit path used Map delete+re-insert for LRU touch (O(log n) + allocation on hot path). **Fixed** — replaced with `publicKeyLastAccess.set(kid, Date.now())` (single map write) — see [[arc-tokens]]
- [x] P-W27 — `allowedScopes` stored as raw comma-separated string; split+includes on every cache-hit scope check. **Fixed** — stored as `Set<string>` parsed once at DB-miss time; hit path uses `Set.has()` O(1) — see [[arc-tokens]]
- [x] P-I16 — `tokenCache` used FIFO eviction (insertion-order head eviction). **Fixed** — `tokenLastAccess` side-map added; `getOrCreateArcToken` evicts true LRU entry on overflow; sweep/clear functions maintain the side map — see [[arc-tokens]]
- [x] P-W1 (explore) — `ExplorePage` not lazy-loaded despite being the heaviest route. **Fixed** — wrapped in `lazy()` for route-level code splitting
- [x] P-W2 (explore) — Render-blocking Google Fonts `@import` in CSS. **Fixed** — moved to `<link>` tags in `index.html` with `preconnect` hints
- [ ] P-W28 (explore) — `GET /venues` (`listAllVenues`) does an unbounded table scan to feed the Explore map; replace with a bbox-aware query (`WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ?`, viewport derived from the map) and an in-memory haversine refine. Same shape needed for events (`listEvents` accepts no bbox today either) — both surfaces should share a `(minLat, maxLat, minLng, maxLng, limit)` contract. Pre-req: compound index on `(latitude, longitude)` (already present on `venues_lat_lng_idx`, `events_lat_lng_idx`). When built, select a thin pin projection (`id, orgHandle, handle, name, kind, capacity, latitude, longitude`) instead of `SELECT *` — the map renders none of the heavy fields (description, hours JSON, image/website URLs). Owner: Pulse — see [[venues]], [[event-access]]
- [ ] P-W23 — `tailwind-merge` (~12-14 KB) in initial bundle — see [[component-library]]
- [ ] P-W24 — `cn()` with signal reads replaces `classList` — avoid in `<For>` loops — see [[component-library]]
- [x] P-W3 (org) — Sequential queries in `removeMember` and `updateOrganisation` could be parallelised. **Fixed** — `callerMember`+`targetMember` in `removeMember` and `orgRows`+`memberRows` in `updateOrganisation` now use `Effect.all({ concurrency: 2 })`. `resolveOrg`+`resolveHandle` in the three member routes now run via `Promise.all`
- [ ] P-W6 (recs) — No caching/pagination contract on `/recommendations/connections`. Every request re-runs the FOF pipeline. Add short-lived per-caller cache (5-15 min) and/or `generated_at` timestamp so clients can detect cached responses — see [[social-graph]]
- [ ] P-W7 (recs) — FOF aggregation in JS after capping fan-out (current). Next step: push aggregation to SQL via `SELECT candidate_id, COUNT(*) FROM (...) GROUP BY candidate_id ORDER BY count DESC LIMIT ?`. Add compound indexes `connections(status, requester_id)` + `connections(status, addressee_id)` — see [[social-graph]]
- [ ] P-W2 (auth-ttl) — 3600s → 300s access-token TTL raises `/token` write load ~12× per session (DELETE+INSERT on `sessions` each refresh). Single-flight refresh (shipped as S-H1 fix) caps concurrent multiplication but doesn't change the baseline. Before horizontal-scale promotion: (a) watch `osn.auth.token.refresh` rate, (b) consider window-based session rotation (only rotate the refresh-token row when `now - createdAt > rotateAfterMs`) so the common case becomes "issue new access token, leave sessions row untouched" while still preserving C2 reuse detection — see [[identity-model]]
- [ ] P-W3 (graphBridge) — `osGet`/`osPost` in `pulse/api/src/services/graphBridge.ts` have span tracing but no per-call latency histogram. Without a histogram we can't set an SLO on the bridge or detect tail-latency regressions; `GET /close-friends` and the rsvps `isCloseFriend` stamp both sit on the bridge's hot path. Add a histogram metric keyed by endpoint + outcome — see [[pulse-close-friends]], [[s2s-patterns]]
- [x] P-W1 (passkey) — `completePasskeyRegistration` MAX_PASSKEYS race guard was SELECT-then-INSERT outside a transaction. **Fixed** — both statements now run inside `db.transaction`, collapsing the TOCTOU window to zero on SQLite — see [[identity-model]]
- [x] P-I1 (passkey) — `deletePasskey` issued two SELECTs against `passkeys` for the same account. **Fixed** — collapsed into one query inside the transaction; the per-account 10-row cap means the in-memory `.some(…)` check is O(1) — see [[identity-model]]
- [x] P-I2 (passkey) — `loginChallenges` map had no hard cap, only TTL eviction. **Fixed** — `MAX_LOGIN_CHALLENGES = 10_000` ceiling enforced on both the identifier-keyed and discoverable (`__disc__:<uuid>`) insert paths — see [[identity-model]]

### Info

- [ ] AZ-P-I1 (authorize-ui, 2026-07-26 prep-pr review of the consent screen) — `osn/social/index.html` sends no `preconnect` to the OSN issuer, so `/authorize` — a **cold cross-origin landing**, no warm connection to reuse — pays DNS + TCP + TLS before `GET /authorize/context` can even start. A `<link rel="preconnect" crossorigin>` built from `VITE_OSN_ISSUER_URL` overlaps that handshake with the JS parse. Needs the issuer origin at build time, same input as **S-L3**'s `connect-src` — do them together. See [[authorize-ui]].
- [ ] AZ-P-I2 (authorize-ui, 2026-07-26 prep-pr review of the consent screen) — `createAuthorizeClient`'s two `fetch` calls carry no `AbortSignal` and no timeout (`osn/client/src/authorize.ts`). A stalled issuer leaves the consent screen on its spinner until the browser gives up; the retry screen added in this PR only helps once the promise settles. Add a `signal` option plus a default `AbortSignal.timeout`, and abort the in-flight context read when the page unmounts. See [[authorize-ui]].
- [x] P-I1 (oidc, 2026-07-24 prep-pr review of the OIDC provider) — `oauth_consents` carried a redundant `oauth_consents_account_idx` on `(account_id)` on top of the `UNIQUE (account_id, client_id)` index, whose leftmost prefix already serves account-only lookups — pure write amplification. **Fixed** — dropped the standalone index across all four mirror surfaces (schema `osn/db/src/schema/index.ts`, migration `0002_wet_gamora.sql`, snapshot `meta/0002_snapshot.json`, test-helper `osn/api/tests/helpers/db.ts`; migration never applied so hand-editing is safe). See [[oidc-provider]].
- [ ] P-I2 (oidc, 2026-07-24 prep-pr review of the OIDC provider) — **kept, forward-looking.** `oauth_clients_sector_idx` on `(sector_identifier)` earns no reads today (clients resolve by `client_id`), but pairwise-subject derivation groups by sector, so the index stays ahead of that read path. Documented so it isn't re-flagged as dead. See [[oidc-provider]].
- [ ] P-I1 (osn-sid, 2026-07-26 prep-pr review of the session-binding fix) — `POST /passkeys/register/complete` resolves the caller's session (up to 50 rows + up to 50 SHA-256 derivations on the binding path) **before** `verifyRegistrationResponse` runs, so a caller sending junk attestation still pays for the scan. Move `resolveCallerSession` after verification, or make `completePasskeyRegistration` take a thunk. Bounded and rate-limited; ordering nit only — see [[sessions]], [[passkey-primary]]
- [ ] P-I3 (osn-sid, 2026-07-26 prep-pr review of the session-binding fix) — `refreshTokens` now generates the session token before signing the access token so the JWT binds to the rotated-in session, which overlaps the sign with the session-metadata `SELECT` instead of running after it. Two round-trips where one would do; batch the metadata read into the rotation write path — see [[sessions]]
- [ ] P-I1 (osn-landing) — `ConnectionsHero.render()` re-maps the ring points (`RING.map(pt)`) each frame during the 1.6 s entrance; hoist alongside `edges` in `rebuildEdges()`. Trivial, animation is bounded. See [[osn-landing]].
- [ ] P-I2 (osn-landing) — `ConstellationCanvas` link loop calls `Math.hypot` per node pair; compare squared distance (`dx*dx+dy*dy < LINK_DIST²`) and only sqrt the surviving pairs. Micro-opt, bounded by `MAX_NODES=120`. See [[osn-landing]].
- [x] P-W1 (cire-landing) — Vine scroll loop repainted the whole field every frame. **Fixed on `claude/cire-landing-page-hcebp7`** — `VineCanvas` now skips redundant `--p` writes (off-screen vines pinned at 0/1 are unchanged → no recalc/paint), bounding per-frame paint to vines crossing the growth front. See [[cire-landing]].
- [x] P-W2 (cire-landing) — Full vine regenerate fired on every resize settle, incl. mobile URL-bar height-only resizes (jank + reseed glitch mid-scroll). **Fixed** — regen gated to real WIDTH changes; the per-load seed is stable across resizes so a genuine resize re-lays-out the same plant. See [[cire-landing]].
- [ ] P-I1 (cire-landing) — Optional: self-host the Google Font WOFF2 subsets (collapses two third-party connections into same-origin `_astro/*` immutable-cached requests) and pass tighter `sizes` to `Figure.astro` where a figure renders narrower than 45vw. Low priority for a low-traffic static page; fold into the apex cutover. See [[cire-landing]].
- [x] P-I1 — `evictExpiredTokens` iterates full cache on every `getOrCreateArcToken` call. **Fixed as P-W102** — debounced internal sweep — see [[arc-tokens]]
- [x] P-I100 — `rotateKey` retry had no jitter; simultaneous failures on horizontal instances caused thundering-herd on `/register-service`. **Fixed** — retry delay is `5 min ± 30 s` — see [[arc-tokens]]
- [x] P-I101 — `startKeyRotation` scheduled a rotation timer for the pre-distributed key path that always silently no-oped. **Fixed** — pre-distributed key path removed entirely; all rotation is ephemeral auto-rotation — see [[arc-tokens]]
- [ ] P-I1 (osn-runtime) — The shared `appRuntime` (`osn/api/src/index.ts`) has no `dispose()` wired to a SIGTERM/SIGINT handler, so a clean shutdown defers the final OTel exporter flush + SQLite close to the platform's grace period. One-time, process-lifetime concern (the opposite of the per-request rebuild it replaced); add a shutdown hook if a graceful-drain story is needed — see [[architecture/backend-patterns]]. **2026-07-03 update:** `pulse/api` + `zap/api` now build one `ManagedRuntime` per route factory (9 total) — same undisposed-at-shutdown posture, and a candidate to consolidate into one shared per-process runtime (osn's `makeAppRunner` model) if/when those services grow an observability layer.
- [ ] P-I1 (pulse) — `Register`/`SignIn` eagerly imported in `Header.tsx` — lazy-load for authenticated users — see [[component-library]]
- [ ] P-I2 (pulse) — Module-level `createSignal` in `createEventSignal.ts` outside reactive owner — wrap in `createRoot` if effects added later
- [ ] P-I3 (share-attribution) — Once an organiser attribution-analytics endpoint lands (the consumer of `share_source_first` / `share_source_last`), add a composite index on `event_rsvps (event_id, share_source_first)` and `(event_id, share_source_last)` to keep the per-event aggregation off a table scan. No-op until that read path exists — see [[event-access]]
- [ ] P-I (series) — `SeriesDetailPage` refetches on every scope tab switch (no cache); `summariseRRule` recomputes on every render — `createMemo` + a `Map<scope, SeriesInstance[]>` cache
- [ ] P-I1 (vid) — `presentations` table grows unbounded per account. When V-M4 lands, add retention to [[compliance/retention]] (e.g. 12 months), index `(account_id, issued_at desc)`, cursor-paginated history view — see [[verified-identity]]
- [ ] P-I2 (vid) — Sybil dedupe will sequential-scan `verified_attributes` without an index. Add a unique partial index on `verified_attributes(document_number_hash) WHERE document_number_hash IS NOT NULL` and a covering `(provider_id, document_number_hash)` index in V-M2 schema migration — see [[verified-identity]]
- [ ] P-I3 (vid) — Per-request AES decrypt for `age_over_16` / `age_over_18` predicates is wasted CPU on hot paths. Store boolean predicates plaintext alongside the encrypted JSON `value` — booleans alone are not Special Category data, only DOB/name need Art. 9 protection — see [[verified-identity]], [[compliance/gdpr]]
- [ ] P-I4 — Deprecated `bx()` still exported from `@osn/ui` — remove once no external consumers remain — see [[component-library]]
- [ ] P-I5 — Auth Dialog components always mounted in EventList (vs conditional `<Show>`) — negligible for two forms but revisit if dialogs grow heavier
- [ ] P-I4 — `AuthProvider` reconstructs Effect `Layer` on every render — wrap with `createMemo`
- [ ] P-I1 (db-dev-tooling) — Root `db:reset` runs the four app resets sequentially via `&&` though the DBs are independent. Wall-clock-only cost on a hand-run command; could fan out via a `turbo run db:reset` task if it ever becomes annoying. Sequential fail-fast is an acceptable default
- [ ] P-I2 (db-dev-tooling) — `cire/db` `db:reset` spawns multiple `bunx wrangler`/`bun run` processes (startup overhead). Negligible on a manual command; collapsing the two D1 `execute` calls in `scripts/cire-db-seed.sh` is only worth it if startup time becomes a nuisance
- [ ] P-I5 — `/graph/internal/connections` has no `offset` parameter — see [[arc-tokens]]
- [ ] P-I3 (recovery) — `generateRecoveryCodesForAccount` computes `genId()` + `hashRecoveryCode()` synchronously for the whole batch before the DB transaction. Nil impact at `RECOVERY_CODE_COUNT = 10` with SHA-256; flag only as a precondition for any future switch to a memory-hard KDF — wrap the `rows.map(...)` in `Effect.sync` so the runtime can yield — see [[recovery-codes]]
- [ ] P-I20 (account-deletion) — Pulse in-memory ARC key registry (`pulse/api/src/lib/arc-middleware.ts`) grows unboundedly across osn-api restarts (each restart registers a fresh kid; old ones stay in the map). Periodic eviction of entries with `expiresAt < now - 24h`, or cap to N most-recent kids per issuer — see [[arc-tokens]]
- [ ] P-I21 (account-deletion) — `runFanOutRetrySweep` `WHERE pulse_done_at IS NULL OR zap_done_at IS NULL` cannot use the partial indexes under an OR; SQLite falls back to a table scan as `deletion_jobs` grows. Replace with `UNION ALL` of two queries (each using its dedicated partial index) deduplicating in JS, OR add a `fanout_pending` generated column. Volume is low so deferred — see [[wiki/compliance/dsar]]
- [ ] P-I2 (security-events) — `listUnacknowledgedSecurityEvents` returns up to 50 rows with no pagination token. Fine for today's single-kind taxonomy, but silently drops older rows if the list grows past the cap. Add `?before=<createdAt>` + `{ events, hasMore }` once another kind is introduced — see [[recovery-codes]]
- [ ] P-I4 (security-events) — `GET /account/security-events` has no `Cache-Control` header. Low-impact today (the query is cheap and the banner fetches once per mount); add `Cache-Control: private, no-store` + a weak ETag on `MAX(created_at)` once the banner starts polling or is embedded outside Settings — see [[recovery-codes]]
- [x] P-I10 — `beginPasskeyRegistration` fetches all passkeys without `LIMIT` — `MAX_PASSKEYS_PER_ACCOUNT = 10` enforced at begin and race-safely re-checked at complete — see [[identity-model]]
- [ ] P-I6 — Duplicate index on `users.email` — `unique()` already creates one implicitly in SQLite
- [ ] P-I1 (client) — Duplicated `authGet`/`authPost`/`authPatch`/`authDelete` helpers across `graph.ts`, `organisations.ts`, `recommendations.ts`. Factor to `@osn/client/src/lib/auth-fetch.ts` parameterised by error-class constructor — see [[component-library]]
- [ ] P-I4 (social) — List pages (`ConnectionsPage`, `OrganisationsPage`) have no pagination UI. Server supports `limit`/`offset` but users with &gt;50 connections silently lose visibility. Add infinite-scroll via `IntersectionObserver` or paginator
- [ ] P-I1 (ratelimit-native) — The Workers native rate-limit bindings (`RL_AUTH_IP_*`, #153) count **per colo**, not globally — an IP hitting two Cloudflare data centres gets up to N× the nominal 60s budget. Accepted trade-off for the 60s auth-IP tier (the 1h IP limiters + per-user/account limiters stay on Upstash for global counting); document so it isn't re-flagged as a bug, and revisit if a distributed auth-flood is observed across colos — see [[rate-limiting]], [[redis]]
- [ ] P-I2 (workerd-otel) — **OTel metric/trace export is deferred on workerd** — the deployed `osn-api` + `cire-api` Workers don't ship app-level OTel to Grafana Cloud (the runtime doesn't support the `@effect/opentelemetry` NodeSdk export path yet); Cloudflare Workers Logs are the interim signal. So `osn.*` / `cire.*` metrics + spans are NOT queryable in Grafana while those services run as Workers. Re-wire once a workerd-compatible exporter lands (or a CF→OTLP bridge). Until then, dashboard work that depends on Worker-emitted metrics is blocked to the Bun-hosted dev path — see [[observability/overview]], [[free-tier-limits]]

---

## Compliance Backlog

Open compliance findings only. Closed items move to a future `wiki/changelog/compliance-fixes.md`, which we create on the first close. See `[[compliance/index]]` for the programme overview and `[[compliance/scope-matrix]]` for the in-scope-laws map. `[[review-findings]]` documents the ID format.

### High

- [ ] **C-H12** — **Pinterest + Google Maps now load by default, with no DPA and no confirmed EU→US transfer basis.** The cire guest site moved third-party content from opt-in to **opt-out** (`claude/site-wide-consent-framework-jys0q2`), so `pinit_main.js` and the Maps Embed iframe fire on first visit for an undecided guest. Both Pinterest and Google rows in `[[compliance/subprocessors]]` still carry open DPA + transfer-basis TODOs, and the Pinterest row previously asserted "keep it opt-in only" — a control the code no longer implements. **Done on branch:** the contradictory sentence is replaced with a dated, explicit statement that this is an accepted, un-approved risk, so the register describes the control actually in force. **Still open:** either a named approver + date for the exception, or flip `CATEGORY_META.embeds.defaultGranted` to `false` (one field). Not an ePrivacy-compliant posture for EU/UK guests — see `[[cire/wiki/architecture/consent]]` and the owner-note on the guest `/privacy` page.
- [x] **C-H1** — _Shipped 2026-07-07_ (`osn/api/src/routes/account-export.ts`, `services/account-export.ts`, step-up verifier in `services/auth/step-up.ts`). Account-level data export endpoint (`GET /account/export`, step-up gated). GDPR Art. 15 + Art. 20 + CCPA right to know. JSON bundle including ARC fan-out to `@pulse/api` (RSVPs, hosted events, close-friends) and `@zap/api` (chat membership; **c2b message bodies now INCLUDED** as `zap.c2b_messages` — server-visible business threads — while c2c/E2E ciphertext stays excluded; added 2026-07-19 PR-A). Streaming JSON, rate-limit 1/day/account. See `[[compliance/dsar]]`, `[[compliance/data-map]]`.
- [x] **C-H2** — Account-level erasure endpoints. Two flows: `DELETE /account` on osn-api (full OSN deletion, 7-day soft-delete tombstone, fan-out to enrolled apps via ARC + retry sweeper); `DELETE /account` on pulse-api (Flow B, leave-Pulse, 7-day grace, hosted-event 14-day public cancellation window). Step-up gated with new `purpose` claim (`account_delete`, `pulse_app_delete`). New `app_enrollments` table tracks per-app opt-in. Recorded in `[[changelog/compliance-fixes]]`.
- [ ] **C-H3** — Photon geocoder keystroke leak (S-M13 follow-up). GDPR Art. 5(1)(c) data minimisation + Art. 7 consent. Proxy through `@pulse/api` so Photon never sees user IP, debounce server-side, add one-time consent dialog on first use. See `[[compliance/data-map]]`, S-M13 in Security Backlog.
- [x] **C-H4** — Privacy notice + ToS published. GDPR Art. 12-14 + CCPA notice-at-collection + DSA Art. 14. **Cire guest site shipped `/privacy` + `/terms` with a site-wide footer (PR #124)** — Australia/APP framing, controller Aniket Chavan, DSAR contact owner@example.com, 1-year retention basis, plain language, linked from the RSVP point of collection. The parallel `@osn/landing` notice (drafts under `wiki/compliance/legal-drafts/`) remains a follow-up. Move to `wiki/changelog/compliance-fixes.md`. See `[[compliance/gdpr]]`, `[[compliance/dsa]]`, `[[compliance/ccpa]]`, `[[changelog/compliance-fixes]]`.
- [ ] **C-H5** — DPA + SCC pack signed for active processors. GDPR Art. 28 + Art. 44-49. Cloudflare DPA, Grafana Labs DPA + SCCs, chosen Redis provider DPA, Komoot/Photon DPA. File under `wiki/compliance/dpa/<vendor>.md` with execution date + scope. See `[[compliance/subprocessors]]`.
- [ ] **C-H6** — DSA notice-and-action endpoint (`POST /reports`). DSA Art. 16. Lands in both `@pulse/api` and `@zap/api` with shared `@shared/moderation` package. Accepts the Art. 16 minimum schema (substantiated explanation, exact location, notifier identity, good-faith statement). See `[[compliance/dsa]]`.
- [ ] **C-H7** — DSA statement-of-reasons system. DSA Art. 17. `moderation_actions` table + email template + `GET /account/moderation-actions` for the affected user. Mandatory for every restriction (post removal, account suspension, demotion, RSVP rejection by host). See `[[compliance/dsa]]`.
- [x] **C-H8** — _Shipped 2026-07-07_ (`BirthdateSchema` in `osn/api/src/services/auth/helpers.ts`; `birthdate` required by `routes/auth/registration.ts`). Date-of-birth field + age gate on registration. COPPA actual-knowledge defense. TypeBox `birthdate: Date` schema; reject under-13 before email OTP send; rejected DOB not retained. See `[[compliance/coppa]]`. **Note**: the V-M2 verified-identity flow can short-circuit this self-declared path with a verified `age_over_16` attribute — see [[verified-identity]].
- [ ] **C-H9** — DPIA for Verified Identity (V-M0 prerequisite). GDPR Art. 35. Biometric template hashes + identity-document data are Special Category Personal Data under Art. 9; DPIA must be filed before the first KYC vendor is wired. See [[verified-identity]], [[compliance/gdpr]].
- [ ] **C-H10** — DVS access registration with the Department of Home Affairs (V-M2 prerequisite). Australian Privacy Act 1988 + APP 11 + DVS-approved consent statement displayed verbatim before each call. See [[verified-identity]], [[compliance/data-map]].
- [ ] **C-H11** — Art. 9 explicit-consent capture for Verified Identity. Each verification ceremony must capture timestamp + version + locale + SHA-256 of the exact wording shown, stored in a `consent_records` table (likely scaffolds C-L1 ahead of schedule). Withdrawal path documented. Block V-M1 — see [[verified-identity]], [[compliance/gdpr]].

### Medium

- [ ] **C-M19** — **No demonstrable record of consent (GDPR Art. 7(1)).** The cire consent decision lives solely in a client-writable, non-`HttpOnly` `cire_consent` cookie; `record.ts` describes `decidedAt` as the Art. 7(1) audit trail but the controller holds no copy and the guest can author any value. Matters more now consent is the basis relied on for the US transfers in C-H12. Either persist decisions server-side keyed by the existing `cire_session` (the cookie transport was chosen specifically so the server *can* read it), or record in `[[compliance/]]` that consent proof is not retained so the gap is knowingly accepted rather than assumed away. See `[[cire/wiki/architecture/consent]]`.
- [ ] **C-M20** — **Google Maps + Google Fonts added to the subprocessor register with open DPA / transfer-basis TODOs.** Declaring the transfers (both were previously undeclared) is the right move but does not supply a lawful basis. File the Google Cloud DPA + transfer basis, or record the accepted risk with a date. Prioritise the tracked font self-hosting item in `cire/wiki/todo/web.md` — Fonts is the only unconditional transfer left and the one the consent framework structurally cannot govern, so removing the vendor retires the row rather than papering over it.
- [ ] **C-M1** — DSAR runbook operationalised (`dsar_requests` audit table, `dsar@osn.example` email alias + automated acknowledgement, postal address on landing legal page, internal triage doc, SLA monitoring alerting at 25 d). GDPR + CCPA + state-law DSARs. See `[[compliance/dsar]]`.
- [ ] **C-M2** — Sweeper jobs for retention windows: `security_events` >12 months, `email_changes` >90 days, expired `sessions` rows, deletion tombstones >30 days. GDPR Art. 5(1)(e). Single cron-style worker in `@osn/api` using Bun `setInterval`. See `[[compliance/retention]]`.
- [ ] **C-M3** — DPIA template + first three filings: Pulse special-category event exposure, Zap M3 org-chat transcripts (before M3 ships), Zap M4 locality channels (before M4 ships). GDPR Art. 35. See `[[compliance/gdpr]]`.
- [ ] **C-M3-ui (oidc)** — Art. 7(3) **surface** follow-up: the standalone revoke path now exists as API (`DELETE /oidc/connections/:clientId`, kills in-flight codes; C-M3 oidc closed 2026-07-24), but "as easy as granting" ultimately wants a visible settings screen listing connections with a revoke button. Build with the consent/settings UI. See [[oidc-provider]], `[[compliance/gdpr]]`.
- [ ] **C-M4** — Continuous-control monitoring tool selected (Vanta / Drata / Secureframe) before SOC 2 Type I prep. SOC 2 evidence-collection lifecycle. See `[[compliance/soc2]]`.
- [ ] **C-M5** — Production access control matrix (`wiki/compliance/access-matrix/<YYYY>-<Q>.md`) — first cycle 2026-Q3. SOC 2 CC6. See `[[compliance/access-control]]`.
- [ ] **C-M6** — Backup + DR plan finalised + first restore drill (Q3 2026 dry run). SOC 2 A1. RTO 4h / RPO 24h initial targets. See `[[compliance/backup-dr]]`.
- [ ] **C-M7** — Dependency CVE scanning in CI (`osv-scanner` or equivalent). Fail on critical, warn on high. SOC 2 CC7 + supply-chain hygiene. See `[[compliance/soc2]]`.
- [ ] **C-M8** — `security.txt` + Vulnerability Disclosure Policy (`/.well-known/security.txt` on `@osn/landing`; VDP at `wiki/compliance/vdp.md`). SOC 2 CC2 + breach-detection channel. See `[[compliance/soc2]]`, `[[compliance/breach-response]]`.
- [ ] **C-M9** — "Do Not Sell or Share My Personal Information" + "Limit Use of My Sensitive Personal Information" footer links on `@osn/landing`. CCPA + state-privacy laws. We do not sell/share but the link is mandatory. See `[[compliance/ccpa]]`.
- [ ] **C-M10** — DSA points of contact (Art. 11 authority + Art. 12 user) + ToS draft published. See `[[compliance/dsa]]`.
- [ ] **C-M11** — Internal complaint / appeal endpoint (`POST /moderation/appeals`) routing to a human reviewer; 6-month availability per DSA Art. 20. See `[[compliance/dsa]]`.
- [ ] **C-M12** — Trader-traceability flow built into Zap M3 verification (Art. 30 — name, address, phone, email, registration ID, self-declaration). Block trader from interacting until verified. See `[[compliance/dsa]]`.
- [ ] **C-M13** — Under-13 detected account-deletion runbook for support-discovered minors. Immediate delete + parent notification. COPPA. See `[[compliance/coppa]]`.
- [ ] **C-M14** — Axe-core in CI (`@axe-core/playwright`) running against `@osn/landing`, `@osn/social`, `@pulse/app` on every PR. Fail on serious / critical violations. EAA / WCAG 2.1 AA. See `[[compliance/eaa]]`.
- [ ] **C-M15** — Sweeper-job framework (cron-style worker in `@osn/api`). Foundation for C-M2. See `[[compliance/retention]]`.
- [ ] **C-M16** — `admin_actions` audit log table (append-only) + Grafana log mirror. SOC 2 CC6 attribution requirement. See `[[compliance/access-control]]`.
- [ ] **C-M17** — KYC vendor RFP must enumerate per-vendor data residency (storage region), SCC required (Y/N), DPA template available (Y/N), and sub-sub-processors disclosed (Y/N). Block vendor selection on these columns. See `[[verified-identity]]`, `[[compliance/subprocessors]]`.
- [x] **C-M18 (C-M1, Upstash region)** — **Resolved: Upstash region = `ap-southeast-2` (Sydney).** Co-located with the D1 databases (`oc`/Sydney) + Australian edge traffic for low RSVP/auth-write latency; the project is AU-centric. The P2 Redis backend holds only pseudonymised auth/rate-limit state, so AU hosting raises no new GDPR Chapter V transfer concern — EU/UK guest data transiting to AU is covered by the same consent/notice basis as the rest of the guest data (DPA still to sign under C-H5). Recorded in `[[changelog/compliance-fixes]]`. See `[[compliance/subprocessors]]`, `[[compliance/gdpr]]`.

### Low

- [ ] **C-L33** — **The cire `functional` consent category governs nothing.** It is defined and defaulted ON, and tells the guest it "remembers choices you make while browsing your invite", but no vendor declares it and no `<ConsentGate category="functional">` exists. `categories.ts` argues explicitly against defining a `marketing` category on the grounds that "an unused toggle is a claim we'd have to keep true" — `functional` currently is exactly that, and unlike `analytics` (deliberately OFF, a reserved slot that claims nothing about present behaviour) it is switched on and asserts something false. Either wire first-party preference storage behind it or drop the category until something uses it. See `[[cire/wiki/architecture/consent]]`.
- [ ] **C-L1** — `consents (id, account_id, purpose, given_at, withdrawn_at, evidence)` table. Required once first consent-based purpose lands (geocoder, marketing email, analytics). GDPR Art. 7. See `[[compliance/gdpr]]`.
- [ ] **C-L2** — DPO designated and named on `@osn/landing/legal/contact`. Even if not strictly required, simplifies enterprise customer DPAs. See `[[compliance/gdpr]]`, `[[compliance/breach-response]]`.
- [ ] **C-L3** — Quarterly access review process (calendar + checklist + record under `wiki/compliance/access-reviews/`). First cycle 2026-Q3. SOC 2 CC6. See `[[compliance/access-control]]`.
- [ ] **C-L31** (turnstile-subprocessor, 2026-07-27 prep-pr compliance check) — `[[compliance/subprocessors]]` has rows for Cloudflare email, DNS/TLS and D1/R2 but none for **Turnstile**, which loads `challenges.cloudflare.com/turnstile/v0/api.js` and receives visitor IP + browser signals during sign-in and registration. The gap pre-dates this work (#154/#160 for the cire surfaces) but 2026-07-27 extended the processing to `musubi.social`, the identity origin. Add a Turnstile row (purpose: bot protection; data: IP + client signals; region: US; DPA/SCC status) and note the new origin. Third-party script receiving personal data on our behalf; ePrivacy-relevant on a new origin. See `[[compliance/subprocessors]]`, `[[turnstile]]`.
- [ ] **C-L33** (google-fonts-subprocessor, 2026-07-28 prep-pr compliance check) — browser-loaded **Google Fonts** (`fonts.googleapis.com` / `fonts.gstatic.com`) on the cire guest site + organiser portal transmits visitor IP + user-agent to Google LLC (US) on every invite view, but `[[compliance/subprocessors]]` lists Google only for the server-proxied Geocoding API (LG München I 3 O 17493/20 held exactly this flow unlawful without consent). Pre-existing gap surfaced by the invite-typography branch, which extended the same links with more faces. Add a Google Fonts subprocessor row (transfer basis to confirm), or better: **self-host** Cormorant Garamond + Lato (both OFL-licensed) and delete the flow + the ePrivacy question entirely. See `[[compliance/subprocessors]]`, `[[apps/cire]]`.
- [ ] **C-L29** (zap c2b, 2026-07-19 PR-A prep-pr) — zap-api's `/internal/account-export` accepts an `account_id` in the request body but scopes queries only on `profile_ids` (dead field). Add a defense-in-depth cross-check that every requested `profile_id` belongs to the declared `account_id` before executing, so a buggy/compromised trusted caller can't over-fetch. Not externally exploitable (ARC-gated). Target: cire Vendors S4 **PR B** or post-launch hardening.
- [ ] **C-L30** (zap c2b, 2026-07-19 PR-A prep-pr) — **c2b message bodies are server-visible PII** now (enquiry threads, exported via DSAR §C-H1). Add data-map + retention rows for `zap.messages.body` (c2b) and the cire `vendor_enquiries` metadata; couple/vendor "enquiries aren't end-to-end encrypted" notice. Owned by cire Vendors S4 **PR B** (the enquiry compliance surface). See `[[compliance/data-map]]`, `[[compliance/retention]]`.
- [ ] **C-L31** (astro-telemetry, 2026-07-21 prep-pr security review) — astro 7 expands `@astrojs/telemetry`'s payload class: the new `am-i-vibing` dep detects AI-coding-agent-driven builds and includes that signal. Developer/build-environment data only (not end-user PII, no subprocessor row needed), but CI builds should be network-deterministic: set `ASTRO_TELEMETRY_DISABLED=1` in workflow env for the astro build jobs (deploy.yml, deploy-osn-pulse-landing.yml, ci.yml) and `.env.example`. See `[[compliance/soc2]]`.
- [ ] **C-L4** — GitHub org hardening: required hardware-key MFA, required signed commits, branch protection, codeowners on prod paths. SOC 2 CC6 + CC8. See `[[compliance/access-control]]`.
- [x] **C-L32** (pulse-landing) — new IP-geo processing surface (`@pulse/landing` `/api/geo`) needed an Art. 30 ROPA row. **Fixed** — added to `[[compliance/data-map]]` Cross-cutting: coarse city-level, Art. 6(1)(f) legitimate interest, computed per request at the edge, not retained, no third party, no cookies. See `[[pulse-landing]]`.
- [ ] **C-L5** — Annual third-party penetration test before SOC 2 Type II. Budget allocation. See `[[compliance/soc2]]`.
- [ ] **C-L6** — Cyber + E&O insurance quote before first paying customer. Claim contact listed in `[[compliance/breach-response]]`. See `[[compliance/soc2]]`, `[[compliance/breach-response]]`.
- [ ] **C-L7** — Global Privacy Control (`Sec-GPC: 1` header) recognition middleware in `@osn/api`. CCPA + Connecticut + Colorado universal-opt-out signal. See `[[compliance/ccpa]]`.
- [ ] **C-L8** — Recommender-transparency disclosure in ToS (Pulse discovery factors documented in plain language). DSA Art. 27. See `[[compliance/dsa]]`.
- [ ] **C-L9** — Strike system + misuse safeguards: counter on accounts; auto-suspend at threshold; auto-rate-limit unfounded reporters. DSA Art. 23. See `[[compliance/dsa]]`.
- [ ] **C-L10** — Annual transparency-report data collection scaffold (we are SME-exempt today but the data should be collected anyway, ready to publish if threshold crossed). DSA Art. 15 / 24. See `[[compliance/dsa]]`.
- [ ] **C-L11** — Annual COPPA self-assessment (30-min doc confirming the design has not drifted toward a child audience). See `[[compliance/coppa]]`.
- [ ] **C-L12** — Verify `oxlintrc.json` `jsx-a11y` rules match WCAG 2.1 AA (some are off by default). EAA. See `[[compliance/eaa]]`.
- [ ] **C-L13** — Manual screen-reader pre-release checklist (VoiceOver on macOS Safari, NVDA on Windows Firefox, TalkBack on Android Chrome). EAA. See `[[compliance/eaa]]`.
- [ ] **C-L14** — Pulse map keyboard parity (marker selection, zoom, pan, detail expand). EAA. See `[[compliance/eaa]]`.
- [ ] **C-L15** — Pulse calendar non-colour state cues (icons / text labels for "Not Started / Started / Ongoing / Finished"). EAA. See `[[compliance/eaa]]`.
- [ ] **C-L16** — Accessibility statement on `@osn/landing/legal/accessibility` listing supported AT, known gaps, contact. EAA Art. 13. See `[[compliance/eaa]]`.
- [ ] **C-L17** — Captions / transcripts for any video content on `@osn/landing`. EAA Art. 4. See `[[compliance/eaa]]`.
- [ ] **C-L18** — Lint rule blocking new third-party script tags in HTML / Astro templates. Forces explicit decision before flipping us into "ePrivacy consent required". See `[[compliance/eprivacy]]`.
- [ ] **C-L19** — Cookie banner scaffold built into `@osn/landing` (built but not mounted). Mounting requires DPO sign-off. ePrivacy. See `[[compliance/eprivacy]]`.
- [ ] **C-L20** — Pulse event archival flow (`endTime + 90 d` → archived view or status flag). Retention. See `[[compliance/retention]]`.
- [ ] **C-L21** — Tailscale (or equivalent bastion) for direct DB access; no public DB endpoint. SOC 2 CC6. See `[[compliance/access-control]]`.
- [ ] **C-L22** — Departure runbook formalised (the access-revocation checklist). SOC 2 CC6. See `[[compliance/access-control]]`.
- [ ] **C-L23** — GitHub mirror to a second host (Codeberg / Gitlab.com / private S3) for code-catastrophic-loss scenarios. SOC 2 A1. See `[[compliance/backup-dr]]`.
- [ ] **C-L24** — Encryption-at-rest documentation (Supabase / R2 / Redis-provider defaults captured). SOC 2 C1. See `[[compliance/backup-dr]]`.
- [ ] **C-L25** — Backup integrity verification (per-snapshot checksum; reject restores from corrupted snapshots). SOC 2 A1. See `[[compliance/backup-dr]]`.
- [ ] **C-L26** — Cross-link DSA Art. 28 (minor protections) to ToS recommender-transparency disclosure. Verified Identity unlocks credible age-gating; ToS update should ship same PR as V-M1. See `[[verified-identity]]`, `[[compliance/dsa]]`.
- [x] **C-L27 (cire, IB-C-L1)** — _done PR #112_: `[[compliance/data-map]]` + `[[compliance/retention]]` rows added for `cire-assets` invite images + `wedding_invite_customisations`. Erasure reachability remains open (D1 cascade doesn't reach R2, no wedding-delete flow) — recorded in those pages and folded into C-H1 / cire IB-S-L2. GDPR Art. 5(1)(e). See `cire/wiki/todo/security.md`.
- [ ] **C-L28** — Cire vendor claim retention sweeper: purge consumed/expired `vendor_claims` rows (holding sole-trader email PII) once volumes warrant (e.g. rows >90 days old with `status` in `expired`/`consumed`). GDPR Art. 5(1)(e) storage limitation. See `[[compliance/retention]]`.

---

## Auth Improvements (Copenhagen Book Audit)

Findings from auditing OSN auth against [The Copenhagen Book](https://thecopenhagenbook.com/) by pilcrowonpaper. The phases below run in priority order.

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
- [x] M3: Email max length validation (≤255 chars) in `EmailSchema` — done 2026-07-05 (length gate ahead of the format regex; 255-char boundary tested)
- [ ] M5: Increase registration OTP from 6-digit to 8-digit (or 6-char alphanumeric)
- [x] C3-follow-up: Access token TTL cut from 1h → 5min; client `authFetch` silent-refreshes on 401 via the HttpOnly session cookie. Caps XSS blast radius on the remaining localStorage secret. See [[identity-model]]

### Phase 5 — Passkey-primary (Next)
- [x] S-H1 (session): Move in-memory `rotatedSessions` map to Redis so C2 reuse detection survives restart + scales across processes. **Done** — see [[sessions]]
- [ ] Device/session listing + revocation UI (`GET /sessions`, `DELETE /sessions/:id`). **UI only** — the API and the `sessions.user_agent`/`ip_hash` columns shipped (see the checked backend item above); nothing in `osn/social` consumes them yet. Depends on: nothing.
- [x] M-PK: Switch to passkey-primary login — see `[[passkey-primary]]`. OTP/magic-link primary login deleted; recovery code remains as the "lost device" escape hatch; security keys accepted in addition to platform passkeys; `deletePasskey` strict last-passkey guard locks in the ≥1-credential invariant.

---

## Deferred Decisions

| Decision | Context | Revisit When |
|----------|---------|--------------|
| Social media platform name | Need a catchy name | Before starting Phase 3 |
| CI lint gate: deny warnings? | 2026-07-03 quality review drove oxlint 463 → 21 warnings; the 21 survivors are the deliberately-warn jsx-a11y set (native `<dialog>`/`<progress>`/`<output>` refactors that change behaviour). `--deny-warnings` in CI would stop future drift but makes "warn" mean "error" — either fix/waive the a11y set first or keep warnings advisory | Next time lint drift is noticed, or when the a11y items are done |
| Signal vs MLS for Zap group chats — see [[zap]] | Sender-keys is simpler; MLS scales past ~50 members. **Hard constraint either way:** hybrid PQ KEM (classical + ML-KEM-768) — messages are durable and HNDL-exposed | Before Zap M2 |
| Zap media storage (images / voice / video) | Needs E2E-friendly blob storage; SQLite-only won't cut it | When Zap M2 lands |
| Effect.ts adoption | Trial underway in `pulse/api` | After more service coverage |
| Supabase migration | Currently SQLite | When scaling needed |
| Android support | iOS priority | Phase 3 |
| Self-hosting | Enterprise use case | Phase 3 |
| Payment handling | Deferred for Pulse ticketing | After core Pulse features |
| Two-way calendar sync | Currently one-way (Pulse → external) | Phase 2 |
| Community event-ended reporting | 15–20 attendees auto-finish; host notified | When attendee/messaging features land |
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
| Email Worker per-recipient rate-limit bound — see [[email]] | Prevents OSN from flooding an inbox under bug / abuse. Tune once we have send-rate telemetry | After first week of real traffic |
| Dry-run flag for email — see [[email]] | `OSN_EMAIL_DRY_RUN` env knob that short-circuits before Worker dispatch; useful for staging smoke tests | When we need it |
| KYC vendor for V-M1 / V-M2 — see [[verified-identity]] | Persona (top AU age-assurance trial scorer; combined estimation + verification) vs idvPacific (AU-domiciled DVS gateway, OCR-first) vs Equifax IDMatrix (heavyweight gateway) vs MATTR/GBG (mDL-native; mDL roadmap partner) | V-M0 vendor RFP |
| BBS+ vs SD-JWT-per-audience for verified presentations — see [[verified-identity]] | SD-JWT-per-audience is the v1 default (mint a fresh credential per RP); BBS+ adds true unlinkable presentations at higher operational cost | If a documented cross-RP correlation threat lands |
| Verified attributes scope: account-level vs profile-level — see [[verified-identity]], [[identity-model]] | Verification ceremony is per-account; multi-account P3-P6 lets one account hold multiple profiles. Should profile-A be able to present `age_over_18` while profile-B presents nothing, or are attributes always inherited? | Before V-M4 ships consent UX |
| Pulse–cire integration mechanism — see [[cire]] | ARC-token pull (Pulse fetches weddings from `cire/api` at feed time) vs push-on-publish (cire writes into `pulse/db` when a wedding goes live) | When Pulse surfaces cire weddings in its feed |
| vite 7→8 + Astro 6→7 upgrade | **Deferred — ecosystem beta-only (checked 2026-06-21).** vite 8 requires Astro 7, and `astro@7`, `@astrojs/cloudflare@14` (the gating one — `@cire/web` is a live SSR Worker), and `@astrojs/solid-js@7` are all `beta`/`alpha`-only on npm. Root override `"vite": "^7.3.5"` is the single lever holding the whole tree at vite 7; `@osn/social`/`@osn/ui`/`@pulse/app`/`@cire/organiser` already *declare* `vite@^8` in-manifest but are force-held down by it. Astro 7 also ships a Rust compiler default + Rolldown-powered vite 8 (esbuild→Oxc) — re-check the `esbuild`/`postcss` overrides + `cire/web` `astro.config.ts`/`middleware.ts` when upgrading. | When `astro@7`, `@astrojs/cloudflare@14`, `@astrojs/solid-js@7`, and an Astro-7 `@astrojs/check` are all on the `latest` dist-tag — then flip the override to `^8`, `bun install`, full `check`/`test`/`lint`/`build`, and a Cloudflare deploy-preview of the SSR Worker before relying on it |

### Decided this session (2026-06-18) — recorded, no longer open

- **Email provider → degraded-for-now.** osn-api ships with **no** Cloudflare Email Service creds and `OSN_EMAIL_OPTIONAL=true` (no-op transport). The provider choice (Resend / SendGrid / Postmark / SES at the Worker level) is parked until email is re-enabled — see [[email]]. Redis provider likewise **decided: Upstash** (`ap-southeast-2`, C-M18) — see [[redis]].
- **Production domain → `cireweddings.com`** (guest apex / `app.` / `api.` / `id.`; passkey RP ID `cireweddings.com`) — #149. **Superseded twice:** the 2026-07-16 reshuffle moved the guest site to `invite.` and the organiser portal to `host.`, and the 2026-07-27 move took identity off the zone entirely — issuer `id.musubi.social`, RP ID `musubi.social`. See [[musubi-identity-migration]].
- **Maps approach → Google Maps Embed** (key-optional, CSS-card fallback) — #146.
- **WAF vs own rate limiter → keep the app limiter.** The Cloudflare Free WAF (1 rule, 10s window) can't replace the app's per-IP/per-user limiters; WAF is reserved for coarse edge defence. Free dashboard hardening steps documented in [[free-tier-limits]].
- **osn-api topology → single Worker** (split + service-bindings/Access "VPC" evaluated and **deferred**); osn-api runs as one Worker, on `id.musubi.social` since 2026-07-27 (`id.cireweddings.com` until then). The topology decision is unchanged by the move — only the hostname is.
- **Cire test idiom** → unblocked by the Hono → Elysia migration (2026-06-12); cire now follows the platform `it.effect` + `createTestLayer()` convention.

---

## Future

### Phase 2: Polish
- [ ] Advanced discovery algorithms
- [ ] Venue pages with DJ schedules
- [ ] Recurring event management UI — **UI only**; the `event_series` schema, RRULE expander and `/series` routes shipped (see the checked backend item above)
- [ ] Calendar integration improvements
- [ ] Accessibility audit

### Phase 3: Expansion
- [ ] Social media platform (spec exists, implementation deferred)
- [ ] Android support
- [ ] Self-hosting capabilities
- [ ] Third-party API ecosystem
- [ ] Supabase migration (from SQLite)
- [ ] Verified Identity expansion to UK / EU / US (V-M6) — see [[verified-identity]]
