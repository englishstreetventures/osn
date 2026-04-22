---
title: Performance Fixes — Completed
tags: [changelog, performance]
related:
  - "[[TODO]]"
  - "[[redis]]"
  - "[[arc-tokens]]"
  - "[[component-library]]"
last-reviewed: 2026-04-19
---

# Performance Fixes — Completed

Archived completed performance findings from [[TODO]]. Finding IDs follow the [[review-findings]] format. For open findings see the Performance Backlog in [[TODO]].

## Auth Phase 5a (2026-04-19)

- **P-W1** — `revokeAccountSession` fetched all account sessions and JS-filtered to find the handle match. Fixed: `LIKE 'handle%'` on the indexed PK with `LIMIT 1` — O(1) instead of O(sessions-per-account).
- **P-W2** — `listAccountSessions` had no `LIMIT` and no composite index for its `ORDER BY lastUsedAt DESC`. Fixed: `LIMIT MAX_SESSIONS_PER_ACCOUNT` on the query plus a new composite index `sessions(account_id, last_used_at)` served by migration 0005.
- **P-W3** — Email-change rate-cap scan fetched full history and JS-filtered the 7-day window. Fixed: `count()` with `gte(completedAt, windowStart)` predicate served by `email_changes_completed_at_idx`.
- **P-W4** — `verifyRefreshToken` wrote `last_used_at` on every verify (hot-path write amplification). Fixed: coalesce writes to a 60-second threshold — ~60× fewer writes at typical 5-min refresh cadence.
- **P-I3** — Step-up / email-change in-memory ceremony stores didn't sweep on insert. Fixed: `sweepExpired` on every `set` so abandoned ceremonies don't linger.
- **P-I4** — `completeEmailChange` held the writer lock across three reads (account fetch, history count, collision check) plus the writes. Fixed: preflight moved out of the transaction; collision race handled by the UNIQUE(email) constraint catching winners inside the TX.
- **P-I5** — `rotatedSessions` sweep was O(n) per insert → O(n²) over the 30-day window. Fixed: FIFO queue so sweep only inspects the head; belt-and-braces size cap at 100k entries.

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
