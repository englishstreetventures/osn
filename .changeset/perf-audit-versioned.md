---
"@zap/api": patch
"@osn/api": patch
"@osn/client": patch
"@osn/ui": patch
"@pulse/api": patch
"@pulse/db": patch
"@pulse/app": patch
---

Performance audit sweep (versioned packages). No behavioural or security
changes — fail-closed rate limiting, visibility gates, consent checks,
single-use guarantees, and tenant scoping are preserved exactly.

- `@zap/api`: `listChats` is cursor-paginated (default 50, max 100) with a
  composite `(createdAt, id)` keyset cursor (same-second creation bursts are
  never skipped) and caller-scoped cursors (unknown/foreign cursors
  rejected); `getChatMembers` is limit/offset-paginated (default 100, max
  500) and skips its redundant existence load when the route has already
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
