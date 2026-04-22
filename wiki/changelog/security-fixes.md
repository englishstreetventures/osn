---
title: Security Fixes — Completed
tags: [changelog, security]
related:
  - "[[TODO]]"
  - "[[rate-limiting]]"
  - "[[arc-tokens]]"
  - "[[redis]]"
  - "[[identity-model]]"
last-reviewed: 2026-04-22
---

# Security Fixes — Completed

Archived completed security findings from [[TODO]]. Finding IDs follow the [[review-findings]] format. For open findings see the Security Backlog in [[TODO]].

## Auth Phase 5b (2026-04-22)

- **S-H1 (session)** — The C2 reuse-detection map (`rotatedSessions`) was a single-process in-memory `Map`; in a multi-pod deployment a rotation recorded on pod A was invisible to pod B, so a replayed rotated-out token hitting B passed without triggering family revocation. Fixed: extracted `RotatedSessionStore` interface (`osn/api/src/lib/rotated-session-store.ts`) with in-memory + Redis-backed impls, wired from `osn/api/src/index.ts`. Fail-open on Redis error — an outage must not manufacture false-positive family revocations that log legitimate users out — with structured warning logs and a `{backend, action, result}` counter so ops dashboards surface degradation. — see [[sessions]]
- **S-M1 (session)** — The `onError` hook in `osn/api/src/index.ts` annotated logs with `error: String(cause)`, which would leak a credentialed `redis://user:pass@…` URL if ioredis ever embedded one in a connection-level error string. Fixed: route the cause through `sanitizeCause()` from `@shared/redis` before annotation, matching the convention already used by every other Redis error sink in the repo.
- **S-L1 (session)** — The prior design held a JSON-array family-set in Redis (`{ns}:fam:{familyId}`) to drive proactive `revokeFamily` cleanup. `track` was a three-round-trip read-modify-write with no cross-command atomicity, creating a theoretical race under concurrent rotations of the same family. Fixed: dropped the family set entirely. `track` is now a single `SET hashKey = familyId PX ttl`; the DB-level `DELETE FROM sessions WHERE family_id = ?` in `detectReuse` remains the authoritative family revocation. Stale `hash:*` keys expire under their own TTL.
- **S-L2 (session)** — `JSON.parse(existing) as string[]` on the family-set payload was a cast rather than a runtime guard — a malformed value written by a different process (migration, manual intervention) would have propagated a thrown error. Removed by the same family-set drop in S-L1.
- **S-L3 (session)** — `revokeFamily` spread every tracked hash into a single unbounded `DEL` command. Under adversarial `/token` flooding (within the existing rate-limit ceiling) the argument list could have grown large enough to press Redis protocol limits. Removed by the same family-set drop in S-L1.

## Auth Phase 5a (2026-04-19)

- **S-H1** — Step-up jti replay guard was single-process in-memory; a captured token could replay once per pod. Fixed: extracted `StepUpJtiStore` interface; Redis-backed implementation in `osn/api/src/lib/step-up-jti-store.ts` wired from startup, fail-closed on Redis errors. — see [[step-up]]
- **S-H2** — `beginEmailChange` leaked user existence via a distinct "Email already in use" error. Fixed: silently returns `{ sent: true }` on collision (matches `beginRegistration`'s anti-enumeration posture); the UNIQUE(email) constraint at `complete` remains the real defence.
- **S-H3** — `/account/email/begin` was an authenticated email-spam amplifier (per-IP only, bypassable via IP rotation). Fixed: per-account cap of 3 begins per 24h on top of the existing per-IP limit.
- **S-M1** — No per-account session cap; `revokeAccountSession` was O(N) scan. Fixed: `MAX_SESSIONS_PER_ACCOUNT = 50` with LRU-evict in `issueTokens`; revoke uses `LIKE 'handle%'` on the indexed PK.
- **S-M2** — `sessionIpPepper` silently disabled when unset in production. Fixed: fails loudly at startup when `OSN_SESSION_IP_PEPPER` is missing/short in non-local env. — see [[sessions]]
- **S-M4** — Session revoke returned distinct "Session not found" — handle-existence oracle. Fixed: idempotent `revokedSelf: false` on miss (matches `/logout` posture).
- **S-L1** — Step-up and email-change OTPs were tagged `purpose: "login"` on `osn.auth.otp.sent`. Fixed: extended `OtpSentAttrs.purpose` union with `"step_up"` and `"email_change"`.
- **S-L4** — Origin guard warning-only when allowlist empty. Fixed: throws at startup in non-local envs.
- **S-L5** — Email-change OTP message was phishing-friendly at misdelivered inboxes. Fixed: reframed with explicit "someone requested this on your account" so a mistaken recipient reads it as junk.

## Critical

- **S-C1** — Unbounded HTTP route metric cardinality from raw URL paths. Fixed: default `state.route = "unmatched"`.
- **S-C2** — Untrusted ARC `iss` claim became metric label before verification. Fixed: `safeIssuer()` guard, unknown issuers collapse to `"unknown"`.
- **S-C3** — User-supplied `category` unbounded on `pulse.events.created` metric. Fixed: closed `AllowedCategory` union + `bucketCategory()` helper.

## High

- **S-H1** — Rate limited all auth endpoints via per-IP fixed-window limiter. 5 req/min send, 10 req/min verify/complete. Also covers S-H2.
- **S-H2** — `GET /handle/:handle` rate limited at 10 req/IP/min (part of S-H1).
- **S-H3** — Open redirect in `/magic/verify`. Fixed: `allowedRedirectUris` on `AuthConfig`, validated at `/authorize`, `/magic/verify`, `/token`.
- **S-H4** — PKCE now mandatory at `/token`. Also validates redirect_uri match (S-M9).
- **S-H5** — Legacy unauth'd passkey path removed. `resolvePasskeyEnrollPrincipal` returns 401 without auth header.
- **S-H6** — No auth middleware on API routes (OWASP A01). Fixed: POST/PATCH/DELETE require auth.
- **S-H7** — No ownership check on mutating event operations. Fixed: `createdByUserId` NOT NULL + 403.
- **S-H8** — Graph GET endpoints unguarded. Fixed: try/catch with generic error messages.
- **S-H9** — `/register/complete` exploited PKCE bypass. Fixed: issues tokens directly.
- **S-H10** — TOCTOU between OTP verify and user insert. Fixed: unique constraint is source of truth.
- **S-H11** — `email.toLowerCase()` inconsistency. Fixed: lowercased form canonical throughout.
- **S-H12** — `GET /events/:id` didn't gate by `visibility`. Fixed: shared `loadVisibleEvent` helper.
- **S-H13** — `GET /events/:id/ics` leaked private event metadata. Fixed via `loadVisibleEvent`.
- **S-H14** — `GET /events/:id/comms` leaked organiser blast bodies. Fixed via `loadVisibleEvent`.
- **S-H15** — `GET /events/:id/rsvps?status=invited` leaked invite list. Fixed: only event organiser sees invitees.
- **S-H16** — `GET /events/:id/rsvps/counts` leaked private event existence. Fixed via `loadVisibleEvent`.
- **S-H17** — `/ready` probe leaked internal error messages. Fixed: opaque `{ status: "not_ready" }` response.
- **S-H18** — Inbound `traceparent` honoured unconditionally. Fixed: only extracted when ARC header present.
- **S-H19** — `x-request-id` unsanitised (log injection). Fixed: regex validation `/^[A-Za-z0-9_.-]{1,64}$/`.
- **S-H20** — `instrumentedFetch` set `url.full` including query string (leaked OAuth codes). Fixed: no query component in span.
- **S-H1 (multi)** — Client/server field mismatch on passkey enrollment. Fixed: route accepts `profileId`, resolves `accountId` internally.
- **S-H2 (multi)** — Profile ID stored in `passkeys.accountId` column. Fixed: now passes `accountId`.
- **S-H3 (multi)** — Non-atomic account + profile creation. Fixed: wrapped in `db.transaction()`.
- **S-H2 (zap)** — Missing membership check on `GET /chats/:id`. Fixed: `assertMember` gate.
- **S-H3 (zap)** — Missing membership check on `GET /chats/:id/members`. Fixed: `assertMember` gate.
- **S-H4 (zap)** — `PATCH /chats/:id` differentiated 403/404 for non-members. Fixed: 404 for non-members.
- **S-H2 (org)** — Handle enumeration via error message. Fixed: "Handle unavailable".

## Medium

- **S-M2** — In-memory rate limiter resets on restart. Fixed: Redis shared counter (Phase 3).
- **S-M7** — Login OTP attempt limit added: wipes after 5 wrong guesses.
- **S-M9** — `redirect_uri` at `/token` matched against stored value (RFC 6749 §4.1.3). Fixed as part of S-H4.
- **S-M10** — `/passkey/register/begin` arbitrary `userId`. Fixed: auth required (part of S-H5).
- **S-M12** — `limit` query param in `listEvents` uncapped. Fixed: clamped to 1–100.
- **S-M15** — `is-blocked` route leaked whether target had blocked caller. Fixed: one-directional check.
- **S-M16** — No rate limiting on graph write endpoints. Fixed: 60/user/min.
- **S-M17** — Raw DB/Effect errors surfaced in graph responses. Fixed: `safeError()` helper.
- **S-M18** — No input validation on `:handle` route param. Fixed: TypeBox `HandleParam`.
- **S-M22** — `console.log` of OTP in dev fallback. Fixed: gated on `NODE_ENV !== "production"`.
- **S-M23** — `pendingRegistrations` Map unbounded. Fixed: 10k cap + sweep.
- **S-M24** — Biased modulo OTP generation. Fixed: rejection sampling in `genOtpCode()`.
- **S-M25** — Non-constant-time OTP comparison. Fixed: `timingSafeEqualString()`.
- **S-M26** — Differential error responses on `/register/begin`. Fixed: always returns `{ sent: true }`.
- **S-M27** — `close_friends` per-row visibility filter inverted directionality. Fixed: removed bucket; attendance visibility is `connections | no_one`.
- **S-M28** — `getConnectionIds`/`getCloseFriendIds` silently capped at 100. Fixed: raised to `MAX_EVENT_GUESTS` (1000).
- **S-M29** — No `maxLength` on event text fields. Fixed: title 200, description 5000, location/venue 500, category 100.
- **S-M30** — `OTEL_EXPORTER_OTLP_HEADERS` parser tolerated malformed input (header smuggling). Fixed: strict regex validation.
- **S-M31** — Redaction deny-list missing `displayName`. Fixed: added alongside email/handle.
- **S-M32** — `span.recordException(error)` wrote properties outside redactor's reach. Fixed: scrubs via `redact()`.
- **S-M33** — `enrollmentToken` missing from redaction deny-list. Fixed: added both spellings.
- **S-M36** — Async `RateLimiterBackend.check()` rejection was fail-open. Fixed: fail-closed posture.
- **S-M37** — `AuthRateLimiters` type was mutable. Fixed: `Readonly<{...}>`.
- **S-M38** — `RedisLive` logs raw connection error (credential leak). Fixed: `sanitizeCause()`.
- **S-M39** — Redis rate limiter key built from unsanitised input. Fixed: namespace validated, key length bounded.
- **S-M40** — `RedisLive` does not enforce TLS. Fixed: logs warning without `rediss://` in production.
- **S-M41** — `createClientFromUrl()` bypassed TLS warning. Fixed: `initRedisClient()` checks and warns.
- **S-M42** — `initRedisClient()` logged raw `cause.message` (credential leak). Fixed: `sanitizeCause()`.
- **S-M44** — `verifyRefreshToken` didn't check `scope: "account"`. Fixed: guard requires scope.
- **S-M45** — `GET /profiles` sent refresh token in header. Fixed: changed to `POST /profiles/list` with body.
- **S-M46** — `POST /profiles/switch` lacked per-account rate limiting. Fixed: 20 switches/hr.
- **S-M1 (multi)** — Missing email index after UNIQUE removal. Fixed: re-added `users_email_idx`.
- **S-M2 (multi)** — `accountId` exposed in org `listMembers`. Fixed: stripped from projection.
- **S-M2 (org)** — No `org:write` scope constant. Fixed: `_SCOPE_ORG_WRITE` added.
- **Copenhagen Book M2** — Recovery codes: 10 × 64-bit single-use codes, SHA-256 hashed, tight rate limits (3/hr generate, 5/hr login), revoke-all-sessions on consume. See [[recovery-codes]].
- **Access-token TTL reduction** (S-M20 mitigation + S-L1 (social)) — default cut from 3600s → 300s. Client `authFetch` silent-refreshes on 401 via the HttpOnly session cookie so UX is unchanged. XSS blast radius on the localStorage access token drops from ~1h to ≤5min. See [[identity-model]].

## Low

- **S-L5** — `getSession()` returned expired tokens. Fixed.
- **S-L6** — OTP used `Math.random()`. Fixed: `crypto.getRandomValues`.
- **S-L8** — `getCloseFriendsOfBatch` accepted unbounded `userIds` array. Fixed: clamped to 1000.
- **S-L9** — Verbose DB internals in Effect error logs. Fixed: `safeErrorSummary()`.
- **S-L16** — `EventList` `console.error` logs raw server errors. Fixed: gated with `import.meta.env.DEV`.
- **S-L17** — `displayName` returned as `undefined` in graph responses. Fixed: `profileProjection()` normalises to `null`.
- **S-L18** — Graph rate-limit store never evicted expired windows. Fixed: shared `createRateLimiter` with sweep.
- **S-L20** — `sendBlast` logged blast body to stdout. Fixed: log removed.
- **S-L20** (observability) — `loadConfig` silently classified production as `dev`. Fixed: throws on mismatch.
- **S-L21** — `serializeRsvp` returned `invitedByUserId` to all viewers. Fixed: `isOrganiser` flag.
- **S-L25** — `createRateLimiter` exported from barrel (arbitrary config injection). Fixed: removed from barrel.
- **S-L26** — No runtime validation on injected `RateLimiterBackend` shape. Fixed: validated at boot.
- **S-L27** — `no-console` lint rule disabled. Fixed: enabled as `"warn"`.
- **S-L27** (redis) — `initRedisClient()` fail-open startup fallback. Fixed: `REDIS_REQUIRED=true` env var.
- **S-L28** — `createClientFromUrl()` eager ioredis connection. Fixed: `lazyConnect: true`.
- **S-L31** — No input format validation on `profile_id` in `/profiles/switch`. Fixed: TypeBox pattern.
- **S-L32** — `findDefaultProfile` ORDER BY relied on SQLite boolean-as-integer semantics. Fixed: explicit ordering.
- **S-L4 (org)** — No `maxLength` on internal route query params. Fixed: added 50 char limit.
