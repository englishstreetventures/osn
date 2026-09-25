---
title: D1 Read Replication and the Sessions API
aliases:
  - D1 sessions
  - withSession
  - first-primary
  - read replicas
tags:
  - systems
  - infrastructure
  - database
  - performance
status: current
related:
  - "[[d1-session-first-primary]]"
  - "[[database-environments]]"
  - "[[d1-limits]]"
  - "[[backend-patterns]]"
  - "[[cire-development]]"
  - "[[free-tier-limits]]"
  - "[[observability-setup]]"
packages:
  - "@cire/api"
last-reviewed: 2026-09-25
---

# D1 Read Replication and the Sessions API

A D1 database has one **primary**, in one region, and every query goes to it
unless the request opts into a **session**. cire's primary is in Oceania, so a
guest opening an invite from London pays a round trip to Sydney *for each query
the request makes*. Read replication puts read-only copies in other regions;
the [Sessions API](https://developers.cloudflare.com/d1/best-practices/read-replication/)
is how a Worker actually uses them without giving up read-your-writes.

## The cost being paid

What one query costs against the OC-primary `cire-db`:

| Measure | Value |
|---|---|
| Control (no D1 query) | 15.0 ms |
| One extra `SELECT` | 50.7 ms |
| **Cost of one query** | **35.7 ms** (p10 33.0, p90 39.3, n=25) |

*Measured 2026-08-31 — a hand-run latency probe from a Sydney client, timing a
route with one extra `SELECT` against one with none, n=25. No script was kept;
[[#The cost from outside Oceania]] runs the same comparison from a committed
script.*

That is the *near* case. The same query from Europe or North America pays the
transoceanic round trip on top, and a request that reads four tables pays it
four times. Folding queries together — the work in #849, #852 — cuts N. Sessions
cut the distance instead: the first query goes to the primary, and every later
query in the same session can be served by any replica caught up to the
bookmark the first one returned.

```mermaid
graph LR
  subgraph "Without a session"
    E1[Worker in London] -->|query 1| P1[(Primary, Sydney)]
    E1 -->|query 2| P1
    E1 -->|query 3| P1
  end
  subgraph "With a session"
    E2[Worker in London] -->|query 1| P2[(Primary, Sydney)]
    E2 -->|query 2| R2[(Replica, London)]
    E2 -->|query 3| R2
  end
```

## How a session is threaded through the Worker

`D1Database.withSession(constraint)` returns a `D1DatabaseSession` exposing
`prepare`, `batch` and `getBookmark()` — and `prepare` + `batch` are *exactly*
the two methods Drizzle's D1 driver ever calls, so a session can stand in for a
database.

The problem is where to put it. `@cire/api` builds its whole Elysia app graph
**once per isolate** (`aot: false`, ~50 route factories closing over one Drizzle
handle), so a per-request handle cannot be threaded explicitly through the
routes. The seam is `cire/api/src/db/d1-session.ts`:

| Piece | Lifetime | Job |
|---|---|---|
| `createSessionRoutedClient(binding, entry)` | One per isolate for `fetch`; one per invocation for `scheduled` | A stable `{ prepare, batch }` the Drizzle handle is built over. Each call delegates to whichever session is current. `entry` (`"fetch"` or `"scheduled"`) labels the queries that found none. |
| `withD1Session(session, body)` | One per request | Puts a session on an `AsyncLocalStorage` for the duration of `body`. |
| `runInD1Session(d1, body)` | One per request | Opens a fresh session and does the above. Called in `fetch`, wrapping the entire dispatch, and once around each of the six `scheduled` sweeps. |

`node:async_hooks` is available because the Worker sets `nodejs_compat`.

> [!important] Losing the context is safe; crossing it would not be
> With no session on the context the shim falls through to the raw binding —
> every query goes to the primary, which is exactly the behaviour before this
> existed. So a handler that somehow escapes the async context costs latency,
> never correctness.
>
> The dangerous case is the opposite one: two concurrent requests seeing each
> other's session, so request A's read is served by a replica pinned to B's
> older bookmark. Every service query runs through `dbQuery` →
> `Effect.promise` → Effect's fiber scheduler, which batches work from all live
> fibers into shared microtask flushes — precisely where an async-context
> mechanism could cross stores. `d1-session.test.ts` asserts it does not, with
> two interleaved requests run through the real scheduler.

### Noticing a lost context

Because a lost context gives no wrong answer, no test or error shows it. So the
shim reports it itself:

| Signal | When | Where to read it |
|---|---|---|
| Counter `cire.d1.session_missing`, attribute `entry` (`fetch` or `scheduled`) | Every query prepared on the raw binding. A batch is not counted again, since its statements were counted as they were prepared | Nowhere on a deployed tier yet: metrics are a no-op on workerd until a metric reader exists (see [[observability-setup]], Runtime split) |
| Warning `D1 query ran outside a session, so it went to the primary`, field `entry` | The first such query per client: once per isolate for `fetch`, once per cron run for `scheduled` | Workers Logs for `cire-api` |

Either should read zero. Both say that a context was lost, not where. To find
the path, drive it through the probe binding in `cire/api/tests/index.test.ts`
("D1 session routing at the entry points"), which records every query that
reaches the raw binding.

Neither sees a Drizzle handle built over `env.DB` directly, because such a
handle never goes through the shim. The last rule below covers that case.

## The constraint: always `first-primary`

`withSession()` takes `"first-primary"` or `"first-unconstrained"`.

| Constraint | First query | What you get |
|---|---|---|
| `first-primary` | Primary | The request observes every write committed before it started. |
| `first-unconstrained` | Anywhere | One more round trip saved; the request may not see a write that has already committed. |

cire uses `first-primary` Worker-wide — see [[d1-session-first-primary]] for the
choice stated as a decision record. `routes/invite.ts` deliberately serves a
`no-store`, edit-sensitive payload so an organiser's edit shows up the next time
a guest loads the invite — `first-unconstrained` would reintroduce exactly the
staleness that header exists to prevent. One constraint for the whole Worker
keeps that property from depending on which route a request happened to reach.

## Turning replication on

Adopting the Sessions API is **inert until the database has replicas**: with
none, a session behaves exactly as before. So the code ships first and the
switch is flipped afterwards, separately and reversibly.

There is no `wrangler` subcommand as of wrangler 4.x — it is the dashboard
(D1 → database → Settings → Read replication) or the REST API:

```bash
curl -X PUT \
  "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/$DB_ID" \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"read_replication":{"mode":"auto"}}'
```

`mode: "auto"` lets Cloudflare place and manage replicas; `"disabled"` turns it
back off. Replicas are read-only and asynchronous — a write always goes to the
primary, and replication lag is what the bookmark protects a session from.

> [!note] Cost
> Cloudflare's docs are explicit that you "incur the exact same D1 usage billing
> with or without replicas, based on `rows_read` and `rows_written`" — so
> replication changes latency, not the row-count ceilings in
> [[free-tier-limits]]. The docs do not state whether the feature needs a paid
> plan; it does not — the `PUT` above was accepted on this account's free plan
> and `wrangler d1 info cire-db` reports `read_replication.mode  auto`.

### It really is inert without sessions

`cire-db` was switched to `auto` on 2026-08-31, while the deployed Worker still
had no session code. Re-running the probe from §The cost being paid gave a
per-query cost of **36.7 ms** (p10 34.0, p90 40.3, n=29) — the same 35.7 ms as
before, inside the noise. That is the expected result and worth keeping: a query
made outside a session goes to the primary whatever the database is configured
to do, so enabling replication on its own buys nothing and costs nothing. The
saving only appears once a Worker that opens sessions is deployed.

*Measured 2026-08-31 — the same hand-run probe as §The cost being paid, n=29.*

A second thing that measurement cannot show from here: the client and the
primary are both in Oceania, so even with sessions live, a Sydney reader has
almost no distance to save. The win this page is about is for readers in Europe
and North America, and confirming it needs a probe run from one of those
regions: [[#The cost from outside Oceania]].

## The cost from outside Oceania

`first-primary` sends the first query of every request to the Oceania primary,
however far from it the Worker runs. What that costs a Worker in North America
or Europe is the number [[d1-session-first-primary]] is traded against.
[`cire/api/scripts/d1-latency-probe.ts`](../../cire/api/scripts/d1-latency-probe.ts)
measures it on the dev tier, by timing `GET /api/claim/session` two ways, in
alternating pairs:

| Arm | Request | What the Worker does |
|---|---|---|
| Control | No cookie | Finds no session token and answers 401 without touching D1 |
| One `SELECT` | An unknown `cire_session` cookie | Hashes the token, runs one `SELECT` on `sessions`, finds nothing, and answers the same 401 |

Both arms open a `first-primary` session, so the `SELECT` is the request's first
query and goes to the primary. `cire/api/tests/index.test.ts` sends the probe's
own two requests through the Worker and asserts zero queries and exactly one.

**Cost of one query** is the median of the `SELECT` arm minus the median of the
control, the same arithmetic as §The cost being paid. The last column gives the
p10/p50/p90 of the per-pair differences instead: each carries the network jitter
of two requests, so that spread is wider than the D1 cost's own.

| Client | Cloudflare colo | Control p50 | One `SELECT` p50 | Cost of one query | Per-pair difference p10 / p50 / p90 | n |
|---|---|---|---|---|---|---|
| Sydney (local run) | SYD | 16.0 ms | 47.5 ms | **31.5 ms** | 26.4 / 31.8 / 39.0 ms | 50 |
| GitHub-hosted runner | not yet run | — | — | — | — | — |

*Sydney row: measured 2026-09-25 — `bun --no-install cire/api/scripts/d1-latency-probe.ts` from a local client, colo SYD, n=50*

The GitHub-hosted runner row is empty because the workflow has not been run. It
fills from the report the run prints, which ends with a row and a measured
marker for this table.

The two rows use the same route pair, the same database and the same arithmetic,
so they compare directly. The difference between them is the extra distance to
the primary. What a replica near the Worker would answer in cannot be measured
here, since nothing in cire opens a session any other way; the Sydney row, a
Worker next to its database, stands in for it. `cire-db-dev` has its primary in
Oceania, like `cire-db`, and read replication off, so the dev tier serves every
query from the primary.

*Measured 2026-09-25 — `bunx --bun wrangler d1 info cire-db-dev --json` from `cire/api`: `running_in_region: "OC"`, `read_replication.mode: "disabled"`*

### Running the probe

From a GitHub-hosted runner, with Actions → **Probe cire dev D1 first-query
latency** → Run workflow, or:

```bash
gh workflow run cire-d1-latency-probe.yml -R englishstventures/osn              # default sample count
gh workflow run cire-d1-latency-probe.yml -R englishstventures/osn -f samples=100
```

From any other machine, at the repository root:
`bun --no-install cire/api/scripts/d1-latency-probe.ts`, with `SAMPLES` from 25
to 100 to change the pair count.

- **Where it ran.** GitHub picks the runner's region, so a run cannot ask for
  Europe. The report records the Cloudflare colo from each response's `cf-ray`,
  which is where the Worker and its D1 client ran, and the region the runner
  reports about itself.
- **When.** Not while a dev deploy or the nightly dev D1 rebuild
  (`cire-dev-db-rebuild.yml`, 14:00 UTC) is running: migrations and freshly
  deployed isolates both inflate the timings. The job has its own concurrency
  group rather than the deploy's, because joining `deploy-dev-cire-api` would
  let a probe cancel a queued dev deploy. So nothing stops an overlap; the
  report prints the run's window, and a run that overlapped either job is
  discarded and repeated.
- **Pacing.** Requests are spaced from the dev `CLAIM_SESSION_RATE_LIMITER`
  budget in `cire/api/wrangler.toml`, at two thirds of it. Any answer but 401
  stops the run with nothing recorded.
- **A result too small to be real.** The run fails, after printing its report,
  when the cost comes out under 5 ms. No D1 round trip has ever measured that
  low, so it means the `SELECT` arm never reached D1.

## Rules

- **Never `first-unconstrained`.** See above. If a route ever genuinely wants
  it, it needs its own session and its own argument in writing, not a change to
  the Worker-wide constant.
- **One session per unit of work, established at the entry point.** One per
  request in `fetch`, one per sweep in `scheduled`. Not per route, not per
  service — a session opened deeper down starts its own bookmark chain and
  re-pays the first-query trip to the primary.
- **Anything that queries after the response is sent must be created inside the
  session scope.** `ctx.waitUntil(p)` only registers `p`; what matters is where
  `p` was created. Each `scheduled` sweep is wrapped for this reason — one
  session per sweep, not one shared by all six, so six unrelated delete-heavy
  sweeps do not keep advancing a single bookmark that then forwards every read
  to the primary anyway.
- **Build the Drizzle handle over the shim, never over `env.DB` directly** —
  a handle over the raw binding silently opts every query it serves out of
  replication, with no error to notice.

## History

| Date | Change |
|---|---|
| 2026-08-31 | Measured the per-query cost from Sydney: 35.7 ms against the OC primary. |
| 2026-08-31 | Read replication switched to `auto` on `cire-db` (free plan). Measured no change, as expected — nothing opened a session yet. |
| 2026-09-01 | `@cire/api` adopts the Sessions API — `db/d1-session.ts`, one session per `fetch` and per `scheduled` sweep, `first-primary`. Ships inert. |
