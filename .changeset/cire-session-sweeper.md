---
"@cire/api": minor
---

Add a scheduled sweeper that prunes expired guest sessions (C-M2/C-M15).

Every guest login writes a `sessions` row with a 30-day TTL, but the read
path only *reports* expiry (`validate` returns `expired`) — it never deletes
the dead row, so the table grew unbounded.

- New `sessionService.sweepExpired(now)` deletes every session whose
  `expiresAt <= now` (inclusive boundary) and returns the deleted row count,
  emitting the new `cire.session.swept` counter (sum tracks reclaimed rows).
- The Worker default export gains a `scheduled(event, env, ctx)` handler that
  runs the sweep against a per-isolate D1 Drizzle client and keeps the isolate
  alive via `ctx.waitUntil`. The existing `fetch` handler is unchanged.
- `wrangler.toml` adds a `[triggers] crons = ["0 4 * * *"]` daily 04:00 UTC
  trigger. No separate retention knob — `expiresAt` already encodes when a row
  becomes dead.
