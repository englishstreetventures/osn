---
"@cire/api": patch
---

Route every request's D1 queries through one D1 session, so read replicas can serve them.

Without a session, each `prepare()` is an independent query and D1 sends all of
them to the primary database. cire's primary is in Oceania, so a request served
from a European or North American colo pays the full round trip to Sydney *per
query* — measured at ~36 ms each from a Sydney client against the OC primary,
and far worse from further away. With replication on, a session pins the first
query to the primary and lets every later query be served by any replica caught
up to the bookmark the first one returned: N × distance collapses to one round
trip plus N-1 local reads.

- New `db/d1-session.ts`. The Elysia app graph is built once per isolate with
  the Drizzle handle baked in and ~50 route factories closing over it, so a
  per-request handle cannot be threaded explicitly. Instead the handle is built
  over a stable client shim whose `prepare`/`batch` delegate to whichever
  session is current on an `AsyncLocalStorage`, established per request in
  `fetch` (and once around the six `scheduled` sweeps). Outside a session the
  shim falls through to the raw binding — exactly today's behaviour — so losing
  the context costs latency, never correctness.
- `createD1Db` now takes the two-method `D1QueryClient` rather than a full
  `D1Database`: those two methods (`prepare`, `batch`) are all Drizzle's D1
  driver ever calls, and are exactly what a `D1DatabaseSession` exposes.
- The constraint is `first-primary`, never `first-unconstrained`, so a request
  always observes every write committed before it started. `routes/invite.ts`
  serves a `no-store`, edit-sensitive payload precisely so organiser edits show
  up on the guest invite's revalidation; one constraint Worker-wide keeps that
  from depending on which route was reached.

Safe to ship before replication is enabled: with no replicas a session behaves
exactly as today. Tests cover the routing (including two interleaved requests
kept apart across Effect's fiber scheduler, which is what every service query
runs on) and a real workerd-backed D1 via Miniflare.
