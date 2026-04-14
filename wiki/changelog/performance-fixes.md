---
title: Performance Fixes — Completed
tags: [changelog, performance]
related:
  - "[[TODO]]"
  - "[[redis]]"
  - "[[arc-tokens]]"
  - "[[component-library]]"
last-reviewed: 2026-04-14
---

# Performance Fixes — Completed

Archived completed performance findings from [[TODO]]. Finding IDs follow the [[review-findings]] format. For open findings see the Performance Backlog in [[TODO]].

## Critical

- **P-C1** — N+1 `getAttendanceVisibility` in `filterByAttendeePrivacy`. Fixed: batch query with `getAttendanceVisibilityBatch`.
- **P-C1 (zap)** — N+1 query in `listChats`. Fixed: single `inArray` query.
- **P-C2 (zap)** — `createChat` inserted members one-by-one. Fixed: batch insert.
- **P-C1 (multi)** — Passkey login query used profile ID against account-scoped column. Fixed: uses `accountId`.
- **P-C2 (multi)** — `users.email` index dropped during schema rewrite. Fixed: re-added `users_email_idx`.

## Warning

- **P-W1** — `rateLimitStore` in graph routes unbounded. Fixed: shared `createRateLimiter` with sweep + maxEntries.
- **P-W6** — N+1 queries in graph list functions. Fixed: `inArray` batch fetches.
- **P-W7** — `eitherBlocked` two sequential `isBlocked` calls. Fixed: single OR query.
- **P-W8** — `blockProfile` SELECT-then-DELETE. Fixed: direct `DELETE WHERE OR`.
- **P-W9** — Extra `getEvent` round-trip in `updateEvent`. Fixed: returns in-memory merged result.
- **P-W12** — `listEvents` clamped with LIMIT before JS visibility filter. Fixed: pushed to SQL `WHERE`.
- **P-W13** — `getConnectionIds`/`getCloseFriendIds` capped at 100 (same root as S-M28). Fixed: raised to `MAX_EVENT_GUESTS`.
- **P-W14** — `MapPreview` + Leaflet (~150KB) shipped on every cold start. Fixed: `lazy()` route loading + dynamic Leaflet import.
- **P-W15** — Observability plugin no-op `context.with` call broke parent-based sampling. Fixed: removed, OTel context stashed on `REQUEST_STATE`.
- **P-W16** — Auth rate limiter Maps swept proactively. Fixed: sweep on every `check()`.
- **P-W16** (graph) — Missing index on `close_friends.friend_id`. Fixed: added `close_friends_friend_idx`.
- **P-W17** — Redirect URI allowlist pre-computed. Fixed: `allowedOrigins` Set built once at boot.
- **P-W17** (graph) — `removeConnection` and `blockProfile` not in transaction. Fixed: `db.transaction()`.
- **P-W18** — `@shared/redis` sent full Lua script on every EVAL. Fixed: EVALSHA caching with NOSCRIPT fallback.
- **P-W19** — `@shared/redis` `createMemoryClient` no expiry sweep. Fixed: proactive sweep.
- **P-W20** — Double base64-decode in `requireArc`. Fixed: single `peekClaims()`.
- **P-W21** — Unbounded `profileIds` on batch internal graph endpoints. Fixed: `maxItems: 200`.
- **P-W1 (org)** — Sequential queries in `createOrganisation`. Fixed: `Promise.all`.
- **P-W2 (org)** — Sequential queries in `addMember`. Fixed: parallelised.
- **P-W4 (org)** — `listProfileOrganisations` two-step query. Fixed: single `innerJoin`.
- **P-W5 (org)** — `listMembers` two-step query. Fixed: single `innerJoin`.
- **P-W6 (org)** — `updateOrganisation` re-fetched after update. Fixed: constructs from known state.

## Info

- **P-I3** — `isCloseFriendOf` used `SELECT *`. Fixed: projects only PK.
- **P-I4** — `getCloseFriendsOfBatch` unbounded array. Fixed: clamped to 1000.
- **P-I10** — `Register.tsx` `createEffect` for passkey skip. Fixed: imperative call.
- **P-I11** — `Register.tsx` unnecessary `createMemo`. Fixed: inlined.
- **P-I12** — `Register.tsx` reallocated `RegistrationClient` on every mount. Fixed: module scope.
- **P-I14** — `@shared/redis` `checkRedisHealth` timeout timer leaked. Fixed: `clearTimeout` in `.finally()`.
- **P-I15** — `@shared/redis` `RedisLive` startup ping no timeout. Fixed: 5s timeout.
- **P-I16** (redis) — `void Effect.runPromise(...)` fire-and-forget log in `initRedisClient()`. Fixed: warning-level logs `await`-ed.
- **P-I16** (observability) — `redact()` unconditionally walked every payload. Fixed: primitive fast path.
- **P-I17** — `listEvents`/`listTodayEvents` unbounded concurrency on `applyTransition`. Fixed: bounded to 5.
- **P-I18** — `instrumentedFetch` allocated fresh `Headers` unnecessarily. Fixed: reuse caller's instance.
- **P-I1 (org)** — `createOrganisation` re-fetched inserted org. Fixed: constructs from known inputs.
