---
title: Security Fixes — Completed
tags: [changelog, security]
related:
  - "[[TODO]]"
  - "[[rate-limiting]]"
  - "[[arc-tokens]]"
  - "[[redis]]"
  - "[[identity-model]]"
last-reviewed: 2026-04-14
---

# Security Fixes — Completed

Archived completed security findings from [[TODO]]. Finding IDs follow the [[review-findings]] format. For open findings see the Security Backlog in [[TODO]].

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
