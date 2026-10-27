---
title: Free-Tier Limits & Unavailability Runbook
description: Our provider ceilings (Cloudflare Workers / Durable Objects / D1 / Pages / Turnstile / WAF) on the dev account's Free plan and the production account's Workers Paid plan, what breaks when each is exceeded, how to detect it, the immediate mitigation, and the upgrade trigger/cost. Plus a per-dependency unavailability playbook keyed to the actual fail-open/fail-closed posture in code.
tags: [runbook, ops, free-tier, limits, cloudflare, d1, durable-objects, observability, incident]
severity: high
related:
  - "[[production-deploy]]"
  - "[[rate-limit-incident]]"
  - "[[rate-limiting]]"
  - "[[coordination-store]]"
  - "[[database-environments]]"
  - "[[observability-setup]]"
  - "[[cire-auth]]"
  - "[[dev-environment]]"
  - "[[realtime]]"
last-reviewed: 2026-10-28
---

# Free-Tier Limits & Unavailability Runbook

> Scope: **the production Cloudflare account is on Workers Paid; the dev
> account and every other provider are on their free tiers.** Workers Paid
> covers the production account's Workers, Durable Objects and D1: their daily
> caps become monthly allowances with billed overage, because osn-api's
> coordination store sits on every sign-in path and fails closed
> ([[durable-object-over-upstash]]). The Free ceilings below therefore bind the
> dev account, and production wherever a section says so. Cloudflare Free zone,
> Pages and Turnstile cost nothing. This runbook records every ceiling, what
> breaks when we hit it, how to detect it, the immediate mitigation, and the
> upgrade trigger + cost.
>
> **All numbers below are the documented limits as of `last-reviewed` and
> WILL drift — re-verify against the provider's own pricing page before
> acting on a quota decision.** Each section links its source page.
>
> That covers the ceilings. A figure of **ours** — one only a command here can
> produce — carries that command and the date it was run, in italics under it.
> Re-run it rather than trusting `last-reviewed`, which says someone read the
> page and nothing about whether its numbers are still true.

## Dependency → service map (who depends on what)

| Dependency | Used by | NOT used by |
|---|---|---|
| **Cloudflare Workers** | `osn-api`, **cire-api**, `zap-api`, `cire-invites` (guest SSR), and the site Workers the production stacks deploy: `musubi-landing`, and while staged `cire-host`, `cire-vendor`, `cire-landing`, `osn-social` | the Pages projects |
| **Cloudflare D1** | `osn-db-prod` (osn-api), `cire-db` (cire-api) | — |
| **Cloudflare Pages** | `cire/host`, `cire/vendor`, `cire/landing`, `@musubi/social`, each until its domain moves to its Worker | the Workers |
| **Cloudflare Rate Limiting binding** (Workers, not WAF) | **cire-api** `CLAIM_RATE_LIMITER` (the pre-auth `/api/claim` edge limiter) and the other bindings in its `wrangler.toml`; **osn-api**'s one-minute limiters, `RL_AUTH_IP_*` and `RL_USER_*` ([[rate-limiting]]) | — |
| **Cloudflare Durable Objects** | **cire-api** `REALTIME_HUB` (`TopicHub`, realtime push — [[realtime]]); **osn-api** `COORDINATION` (`CoordinationStore`, the limiters longer than a minute, ceremonies, single-use claims and lockouts — [[coordination-store]]) | zap-api |
| **Turnstile** (widget live; the cire gate is inert — see the 2026-07-20 incident below) | osn-api register + passkey-login, cire-api guest claim + RSVP — gated only while the Worker secret is set | — |

> **Key accuracy note:** **cire-api does NOT use the coordination store.** Its
> rate limiters are native Cloudflare Workers Rate Limiting bindings, declared
> per tier in `cire/api/wrangler.toml`, and in-memory counters per isolate for
> every route without a binding. Its state lives in D1. So a **coordination-store
> failure does not touch cire's own routes** — it degrades **osn-api** auth + (via
> osn-api) any downstream that needs an osn access token, cire sign-in included.
> On dev the two do share one thing: the account's daily Durable Object
> allowance, spent by cire's hub and osn-api's store together.

---

## Cloudflare Workers

**Source:** [workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) · [limits](https://developers.cloudflare.com/workers/platform/limits/) — re-verify.

The table is Workers Free, which the dev account runs. The production account
is on Workers Paid (see Upgrade path below).

| Limit | Free value (re-verify) |
|---|---|
| Requests | **100,000 / day** (per account, across all Workers) |
| CPU time | **10 ms / invocation** |
| External subrequests | **50 / invocation** |
| Subrequests to CF services (D1/R2/KV) | **1,000 / invocation** |
| Worker size | **3 MB / Worker, compressed** |
| WebSocket connections | each connection to a Worker is **one request**; messages over it are **not** requests |

**Worker size.** An upload over the limit is refused, so the Worker keeps its
last version. Alchemy uploads every file a bundled Worker's bundle holds, source
maps included, so each stack's K10 test bundles its API Worker offline and fails
when those files gzip to more than 3 MiB, 3,145,728 bytes
([[infrastructure-as-code#The stacks]]):

| Worker | Bundle, gzip, maps included |
|---|---|
| osn-api | 2,204,229 B |
| cire-api | 2,307,998 B |
| zap-api | 1,108,319 B |

*Measured 2026-10-20 at commit 0d483b3b for cire-api and zap-api, and 2026-10-27 at commit 4b11f1950 for osn-api — the sum each stack's K10 test computes (`node:zlib` gzip at its default level, file by file, maps included). The test prints it only when it fails, so run an untracked copy of `<stack>/infra/tests/bundle.test.ts` that prints `gzipBytes` in place of its last `expect`, with `bunx --bun vitest run tests/<copy>.test.ts` in `<stack>/infra`.*

The guest site's Worker, cire-invites, is a prebuilt upload: the cire stack
stages its Astro server output with each module's source map
([[infrastructure-as-code#Bundling and the module registry]]), and
`scripts/guard-bundle-size.sh` refuses it before upload when modules and maps
together gzip past 3 MiB ([[bundle-size-guards]]):

| Worker | Modules, gzip | Source maps, gzip | Together |
|---|---|---|---|
| cire-invites | 189,154 B (37 files) | 809,812 B (32 files) | 998,966 B |

*Measured 2026-10-23 at commit cbddd6558 — `ASTRO_KEY=<key> bun run --cwd cire/invites build`, then `planPrebuiltStage()` and `writePrebuiltStage()` from `@shared/infra` over `cire/invites/dist/server`, summing `node:zlib` gzip at its default level file by file over the staged copy. The guard's own `gzip -n` reading of the same build is 187,350 B of modules and 805,221 B of maps.*

**WebSocket connections.** [workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) — "WebSocket connections made to a Worker are charged as a request … WebSocket messages routed through a Worker do not count as requests."

**What happens at the cap.** Past 100K requests/day a Free account's Workers
(osn-api **and** cire-api **and** zap-api **and** cire-invites together: the
limit is account-wide, not per Worker) start returning **HTTP 429 from
Cloudflare's edge** — before our handler runs. That is the dev account: the
dev tier runs in its own Cloudflare account ([[dev-environment]]), with its own
100K a day, so dev load cannot 429 production. Production's account, on Workers
Paid, has no daily cap. Cloudflare Access on the dev browser hosts keeps
crawlers and randoms off dev's share.
CPU overruns terminate the
single invocation (`exceededCpu`); subrequest overruns throw "Too many
subrequests" (`exceededResources`).

**User-visible symptom:** site-wide 429s once the daily cap is hit (resets at
UTC midnight); sporadic 5xx/`exceededResources` on unusually heavy single
requests (e.g. a large spreadsheet import making many D1 calls).

**How to detect:** CF dashboard → Workers & Pages → account-level **Requests**
metric vs the 100K line; per-Worker invocation statuses showing
`exceededResources` / `exceededCpu`; Workers Logs invocation records.

**Upgrade path:** **Workers Paid** ($5/mo) — 10M requests/mo included, 30s CPU
default, far higher subrequest ceilings. The production account runs it; the
release checklist confirms the plan before a release ([[production-deploy]]
§5.5). Dev would move with no code change. Re-verify pricing.

---

## Cloudflare Durable Objects

**Source:** [DO pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [DO limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [state API](https://developers.cloudflare.com/durable-objects/api/state/) · [lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/) — re-verify.

Durable Objects run on Workers Free since 2025-04-07, **SQLite storage backend only**. The repo defines two classes, both SQLite-backed and both bound on both tiers: `@shared/realtime`'s `TopicHub`, which cire-api binds as `REALTIME_HUB` ([[realtime]]), and `@shared/coordination`'s `CoordinationStore`, which osn-api binds as `COORDINATION` ([[coordination-store]]). The allowance is per account: on dev the two namespaces spend the Free allowance together; production's account is on Workers Paid, where the daily figures below are monthly allowances with billed overage. The realtime client's pings are not counted as requests (measured below).

**osn-api's coordination store.** Every request through a limiter the store holds, every ceremony step, every use of a step-up token and every lockout check is one or more Durable Object requests; [[coordination-store#Cost]] lists what each call costs. A token refresh makes none. The store is on every sign-in path and fails closed, so once an account's allowance is spent sign-in stops until 00:00 UTC: the limiters deny, the ceremonies answer 503 and step-up refuses. That is why production's account is on Workers Paid. On dev it stops dev sign-in only.

**cire's bound.** Each organiser gets at most 300 subscribes a UTC day (`REALTIME_SUBSCRIBES_PER_DAY` in `cire/api/src/services/realtime.ts`), so spending the allowance on subscribes alone takes more than 333 accounts (100,000 ÷ 300). A helper is an organiser account with the same ceiling, and any account can already create a wedding and subscribe as its owner, so helpers listening adds no subscriber the ceiling did not already bound. The count lives in D1 (`realtime_subscribe_budget`), from the same account-wide 100,000 rows written a day: each subscribe under the ceiling writes one row, whether or not the membership check then admits it, plus one primary-key entry on an organiser's first of the day; a refusal at the ceiling writes none.

Publishes and the client's pings are not bounded per day. A publish is one request (one RPC on the hub's stub; the fan-out to the topic's sockets is outgoing and free), sent only by a write that changed something: a seat change (owner-only but for a member's own leave; 20 a minute per organiser) and a checklist write (`tasks-changed`, [[cire-checklist-tasks#Live refresh]]; 120 a minute per organiser, `defaultTaskWriteLimiter` in `cire/api/src/app.ts`). Every publish and every subscribe also costs a Worker request, so neither spends the Durable Object allowance faster than the Workers allowance anyone can spend.

What a publish costs beyond itself is the re-reads it prompts, from the Workers and D1 allowances. A topic holds at most 50 sockets (`TopicHub.socketCap`), so a publish reaches at most 50 tabs:

- **`members-changed`**: every listening tab re-reads the wedding list (1 Worker request), a helper's included; a tab with the co-host panel open, or a checklist that has read the seats, also reads `GET …/hosts`.
- **`tasks-changed`**: only a tab showing the tasks re-reads them: Overview, the dashboard's default module, or the checklist, on a Gold wedding. Every other tab marks its cache stale and sends nothing. A task re-read is 1 Worker request and 4 D1 statements (the session lookup, the seat lookup, and the two-statement list batch), reading about 3 + T + A rows, T being the wedding's tasks and A its holder rows; the list has no LIMIT. Signals coalesce in each tab: however many land while a re-read is out, one more read follows it.
- So one task write costs, beyond its own request, 1 Durable Object request and at most 50 Worker requests and 200 D1 statements. With 5 tabs showing tasks and T + A = 50, it is 5 Worker requests, 20 statements and about 265 rows read; a busy wedding's 100 task writes a day are 100 Durable Object requests, 500 Worker requests, 2,000 statements and about 26,500 rows read.

Two kinds of subscribe come on top of a tab's first. The hub closes, at the next publish, any socket accepted more than an hour ago (`TopicHub.maxSocketAgeMs`), so the reconnect re-checks the session and the seat; with checklist writes publishing, every listening tab on an active wedding meets this about once an hour. Each reconnect is a subscribe (1 Worker request, 1 Durable Object request, about 4 D1 statements, 1 D1 row written), two wedding-list reads (the client's `dropped` and `reconnected`), and a task re-read where the tab shows tasks: 10 tabs over an 8-hour day are about 80 Durable Object requests, 80 rows written and 240 to 320 Worker requests. And a tab hidden for two ping intervals closes its socket, so a helper's phone subscribes again on every return to the page. Such a return sends no `dropped`; it costs the subscribe, a task re-read where the tab shows tasks, and one wedding-list read. When the last list read is a minute old the return sends that read itself, and the `reconnected` relies on it if the socket reopens within a second of the page being shown; a slower reopening reads the list a second time. Otherwise the `reconnected` sends it. The daily ceiling bounds both: at most 300 Durable Object requests a day per organiser, a helper's included.

*Counted from the code on 2026-10-21 (`socketCap`, `maxSocketAgeMs` and the ping interval in `@shared/realtime`, the statements each cire route runs), not measured.*

Pings are not counted (below), so a helper who keeps a phone open on the day costs about one request a connection, plus one for each reconnect. A helper's screen is the run sheet ([[cire-run-sheet]]), and every `tasks-changed` or `members-changed` sends each open one to read `GET …/run-sheet` again: one cire-api request with three D1 round trips — the session lookup, the seat lookup (which carries the tier) and one batch of four statements, six statements in all — bounded per organiser at 120 a minute by its limiter. A read whose answer names anyone also asks osn-api over ARC for the names the Worker isolate has not cached in the last five minutes: that is a second Worker request on the same account, with osn-api's own D1 reads. Within five minutes of a first read, a burst of publishes costs no ARC call in that isolate.

*Counted from the code on 2026-10-21 (`osnAuth`, `weddingRunSheet`, `runSheetService.read`, `createRunSheetRoutes` and `cacheProfileDisplayResolver`), not measured.*

| Limit | Free value, the dev account (re-verify) | Workers Paid, the production account (re-verify) |
|---|---|---|
| Requests | **100,000 / day** | 1 million / month included, then $0.15 / million |
| Duration | **13,000 GB-s / day** — billed at 128 MB per awake object, so about 101,000 awake-object-seconds a day (13,000 ÷ 0.128) | 400,000 GB-s / month included, then $12.50 / million GB-s |
| SQLite rows read | 5,000,000 / day | 25 billion / month included, then $0.001 / million |
| SQLite rows written | 100,000 / day | 50 million / month included, then $1.00 / million |
| SQLite storage | 5 GB total | 5 GB-month included, then $0.20 / GB-month |
| Classes per account | 100 | |
| WebSocket connections per object | 32,768 | |
| Received WebSocket message | 32 MiB | |

**What counts.** A request "Includes HTTP requests, RPC sessions, WebSocket messages, and alarm invocations". Creating a WebSocket connection is one request, and every RPC call on a stub (the hub's `publish`, each coordination-store call) is one. "There is no charge for outgoing WebSocket messages, nor for incoming WebSocket protocol pings." "Each setAlarm() is billed as a single row written", and "deletes are counted as rows written", so a coordination-store entry with a TTL costs a row for its alarm as well as its own.

The client's `ping` is an application text frame, not a protocol ping. The page says only this about it: "Application level auto-response messages handled by state.setWebSocketAutoResponse() will not incur additional wall-clock time, and so they will not be charged". It does not say whether that sentence covers the request count. The 20:1 ratio for incoming messages is stated "for compute requests billing-only", and the page does not say whether it applies on Free.

A visible tab's pings cost no requests. At the client's 25 s interval (`PING_INTERVAL_MS`), a visible tab open for 8 hours sends 1,152 pings; if each counted, that tab would cost 1,152 requests, or 58 at 20:1. Neither happens: a live connection costs about one request however long it stays open. A hidden tab sends at most two pings before the client closes its socket, two ping intervals after the tab was hidden; showing the tab again opens a new connection, so each reconnect is one more request.

Over about an hour of one organiser checklist tab on `host.dev.cireweddings.com`, in several sessions of about 30 minutes, with its socket open (`101 Switching Protocols`) and pinging every 25 s, the namespace's request chart showed only isolated spikes of 1 to 3 when a connection opened or closed, and nothing between them. Across the 24 hours of testing the namespace logged about 10 requests. If each ping counted, an open socket would add about 144 an hour. A connection's one request is recorded when it closes, not when it opens. Requests that end because the browser dropped the socket (tab closed, hidden-tab pause, reconnect) show as "Errors" in that chart; they are disconnect outcomes, not failures. The session start and end times were not recorded to the minute.

*Measured 2026-10-22 on the dev tier as it then ran in the production account — Cloudflare dashboard, Workers & Pages, Durable Objects, the `cire-api-dev` Worker's `TopicHub` namespace (binding `REALTIME_HUB`), Metrics, Requests, 24-hour view; one organiser checklist tab, about 1 hour.*

**What keeps an object awake.** A pending `setTimeout`/`setInterval`, pending I/O or a request in flight stops hibernation. An idle object that meets the hibernation conditions hibernates after 10 s and is not billed for duration, even in those 10 s. One that does not meet them stays in memory, billed, until it is evicted 70–140 s after its last request. `TopicHub` holds no timer, alarm or storage write, so it is billed only while a handler runs. `CoordinationStore` holds no timer and no socket; its alarm is stored, wakes the object when due, and counts as one request.

**What happens at the cap.** On a Free account, "Further operations of that type will fail with an error" until the reset at **00:00 UTC**. A realtime subscribe then answers 503 and the client falls back; a publish logs and counts an error, and the write that called it succeeds. The docs do not say which error a WebSocket upgrade sees. A coordination-store call fails like any other, with the posture in [[coordination-store#What each consumer does when a call fails]]. On production's Paid account there is no daily cap; use past the included amounts is billed.

**How to detect:** in the Cloudflare dashboard, Workers & Pages, Durable Objects, compare each namespace's requests and duration with the daily lines (dev) or the month's included amounts (production). The allowance is per account, so dev's namespaces spend the dev account's and production's spend production's. Adding Durable Objects to `scripts/check-free-tier-ceilings.ts` is englishstreetventures/osn#1256. A spent allowance shows in the product's logs as `realtime subscribe failed` at step `hub` and `realtime publish failed` for cire, and `coordination store call failed` for osn-api, whose `GET /health/coordination` then answers 503; the counters record nothing on workerd until englishstreetventures/osn#501 lands.

**Upgrade path:** the production account runs Workers Paid. Dev would move with no code change.

---

## Cloudflare D1

**Source:** [d1 pricing](https://developers.cloudflare.com/d1/platform/pricing/) · [limits](https://developers.cloudflare.com/d1/platform/limits/) — re-verify. Applies per account. Production: `osn-db-prod`, `cire-db`, `zap-db-prod` and the unused `osn-db-staging` and `osn-db`. Dev: `cire-db-dev`, `osn-db-dev` and `zap-db-dev`.

The table is D1 on Workers Free, which the dev account runs. The production
account is on Workers Paid, with the D1 allowances under Upgrade path below and
no daily cap.

| Limit | Free value (re-verify) |
|---|---|
| Rows read | **5,000,000 / day** |
| Rows written | **100,000 / day** |
| Storage | **5 GB / account total** |
| Max DB size | **500 MB** |
| Databases | **10 / account** — production 5, dev 3 (see below) |
| Queries per Worker invocation | **50** |
| Max row size | **2 MB** |

**What breaks.** When the daily rows-read or rows-written ceiling is hit, D1
queries start **failing** (the binding returns errors). Because both cire-api
and osn-api **fail closed** on a missing/erroring DB (cire-api: `index.ts`
returns **503** if `env.DB` is absent/erroring), the symptom is **503s on any
DB-touching route** — i.e. effectively the whole app, since auth, claims, RSVP,
graph all read D1. Note the daily counters are **shared across every DB on the
one account** (5 GB storage and the day's read/write counts are account-wide).

**Two accounts, two budgets.** The production account holds `cire-db`,
`osn-db-prod`, `zap-db-prod` and the unused `osn-db-staging` and `osn-db`; the
dev account holds `cire-db-dev`, `osn-db-dev` and `zap-db-dev`. Each account has
its own 10-database limit and its own daily row counts, so dev's D1 use never
spends production's.

**A rebuild from zero is the expensive thing.** Replaying the cire chain from
`0001` (then 57 migrations) and re-seeding cost **8,007 rows written and about
22,630 read**. Run on every merge, thirteen merges on 2026-09-09 spent 104,091
rows written and went over the 100K/day ceiling, as did 2026-08-30, while
production wrote between 3 and 116 rows a day.

*Measured 2026-09-10 — per-day, per-database totals from the Cloudflare GraphQL
`d1AnalyticsAdaptiveGroups` dataset, dimensions `databaseId` and `date`, summing
`rowsRead` and `rowsWritten`.*

An earlier version of this page said a seed was "on the order of tens of rows".
That was wrong by three orders of magnitude, and it blamed the wrong step. The
seed is about 2,060 rows; the cost is the **migration replay**. SQLite rebuilds
the whole table for every `ALTER TABLE ... DROP COLUMN`, and D1 bills that
schema churn even when the table is empty — one such statement on
`wedding_invite_customisations` costs 54 rows written and 421 read against no
data at all. Of the 200 heaviest queries on `cire-db-dev` in the week to
2026-09-10, DDL was 89% of rows written and 99.7% of rows read.

*Measured 2026-09-10 — `bunx wrangler d1 insights cire-db-dev --time-period=7d --sort-by=writes`, and the same with `--sort-by=reads`.*

No job rebuilds a database from zero. The dev stacks migrate each dev database
forward, as production does, and import a seed only when its file changes; a
fresh dev database replays the squashed baseline once, on the dev account's
first deploy ([[dev-environment]]).

**The number to watch is per-deploy, not per-day.** Any job that rebuilds a
database from zero costs rows in proportion to the *number of migrations*, not
the amount of data, and that number only grows. Before adding one, work out its
cost against 100K/day. `scripts/guard-d1-migration-cost.ts` works the cire chain
out on every pull request — replaying it offline into an in-memory SQLite and
failing when the estimate passes the budget in
`scripts/d1-migration-cost-budgets.txt`. The chain is one squashed baseline of
**96 schema writes** against a line at 192; priced at 27 rows each that is
about 2,590 written and roughly 38 replays a day, but the price per schema
write is only pinned to about 22–27, so read the row figure as indicative and
the schema-write count as exact. Method, calibration and how to re-baseline:
[[bundle-size-guards]], which also sets out why the "89% / 11%" split above
cannot be read as a share of one rebuild.
*Measured 2026-10-02 — `bun run scripts/guard-d1-migration-cost.ts --all`.*

**Seating plan copies have a daily ceiling.** One copy of a seating plan writes
the plan, up to 100 tables and a seat for every guest seated in it, and D1
bills a row written for each row and each index entry it enters (the D1
pricing page above): four for a table or a seat. A copy of a full plan for a
1,000-guest event is therefore about 4,400 rows written. Each wedding copies at
most 3,000 tables and seats a UTC day (`MAX_COPIED_ROWS_PER_DAY` in
`cire/api/src/schemas/seating.ts`), counted in D1 (`seating_copy_budget`) and
checked in the copy's own INSERT, so one wedding's copies write at most about
12,000 rows a day, whichever isolate serves them; deleting a plan removes only
rows that were written first ([[cire-seating]]).

**Every osn-api token refresh writes about eight more rows.** A refresh inserts
one `rotated_sessions` record in the batch that inserts the new session
([[sessions]]): the row, its primary-key index and its two secondary indexes,
about 4 rows written. The 6-hourly cron deletes the record once it expires,
30 days later, about 4 more. A sweep run deletes chunks of 500
(`ROTATED_SESSION_SWEEP_CHUNK` in `osn/api/src/services/auth/constants.ts`), at
most the tier's chunk count (`OSN_ROTATED_SESSION_SWEEP_MAX_CHUNKS`, read by
`rotatedSweepMaxChunks` in `tokens.ts`). Dev leaves it unset, so 10 chunks:
5,000 records and about 20,000 rows written a run, 10 of the 50 D1 queries the
cron's four sweeps share. Staging and production set 100: 50,000 records a
run, 100 statements, inside Workers Paid's 1,000 queries per invocation, which
keeps up with about 2,000 people signed in eight hours a day. On dev's 100,000
rows a day, eight rows a refresh is about 12,500 refreshes a day, shared with
everything else on the dev account. A run that ends on a full chunk logs
`auth.session.rotated_sweep ended on a full chunk`; watch for it in Workers Logs.

*Counted from the schema (`osn/db/src/schema/index.ts`, `rotatedSessions`) and the pricing page's rule that each index entry is a row written, on 2026-10-27; not measured.*

**The daily cire cron shares one invocation.** Its eleven jobs (`cire/api/src/index.ts` `scheduled`) all count against the same 50-queries-per-invocation ceiling. Read from the code, a quiet day costs about 11 D1 calls and a busy one 21 or more, before the vendor claim hand-off adds 2 reads plus one write per enquiry, capped at `HANDOFFS_PER_RUN` = 10 (`cire/api/src/services/claim-review.ts`), and the purge of soft-deleted weddings adds 2 reads plus one 5-statement batch per wedding, capped at `MAX_PURGES_PER_RUN` = 3 (`cire/api/src/services/maintenance-sweeps.ts`). The purge's rows written are the cascade of each wedding it deletes — mostly rows the 1-year guest sweep would delete anyway. The two R2 orphan reconcilers each list at most 1,000 objects in at most 3 `list()` calls a run (`ASSET_LIST_LIMITS` in `cire/api/src/services/asset-reconcile.ts`, `SHEET_LIST_LIMITS` in `cire/api/src/services/sheet-reconcile.ts`), resuming where the last run stopped, and make no D1 call when nothing they listed is old enough to delete. Otherwise `cire-assets` makes one read, of every key its three tables hold, and `cire-sheets` two: one row of `imports`, then one lookup of the keys it listed, sent as one bound parameter of about 65 KB at most. D1 still scans `imports` for that lookup, since no index covers the key columns, and returns one row: the table's row count, for the hold on a halving of rows, and the matching rows' keys as one JSON value, both from that one scan.

*Unverified — estimated from reading the code on 2026-10-01, plus both R2 reconcilers on 2026-10-02, counting a batch as one call; neither reconciler's CPU time has been measured; whether D1 counts a batch as one query or one per statement is to re-check. The measurement is a post-merge follow-up: on dev, soft-delete the seeded wedding and backdate `deleted_at` by 8 days, let the 04:00 UTC cron run, then read `bunx wrangler d1 insights cire-db-dev --time-period=1d --sort-by=writes` with the dev account's credentials.*

**User-visible symptom:** 503 / "service unavailable" across the app until the
daily counter resets at **UTC midnight**, or storage is freed.

**How to detect:** CF dashboard → Workers & Pages → D1 → database → metrics
(rows read/written vs the daily line, storage vs 5 GB); Workers Logs error
lines from the D1 query path.

For per-day, per-database numbers without the dashboard, query the GraphQL
analytics API — `d1AnalyticsAdaptiveGroups`, dimensions `databaseId` and `date`,
sum `rowsRead`/`rowsWritten`/`readQueries`/`writeQueries`. To find *which query*
is spending them:

```bash
bunx wrangler d1 insights <db> --time-period=7d --sort-by=writes --limit=20 --json
bunx wrangler d1 insights <db> --time-period=7d --sort-by=reads  --limit=20 --json
```

**Upgrade path:** **Workers Paid** unlocks the D1 paid tier — 25B rows
read/mo, 50M rows written/mo and the first 5 GB stored included; 10 GB max DB
size, 50K databases, 1 TB storage; overage is cheap ($0.001/M read, $1/M written, $0.75/GB-mo). Re-verify.

---

## Cloudflare Pages (Free)

**Source:** [pages limits](https://developers.cloudflare.com/pages/platform/limits/) — re-verify. Hosts the production sites (`cire/host`, `cire/vendor`, `cire/landing`, `@musubi/social`), each until its domain moves to a Worker, and the stale musubi and pulse landing preview projects, which no workflow deploys. musubi landing serves from a production Worker, and each Pages site also runs a staged Worker on a spare host ([[infrastructure-as-code#Production sites]]); a request a site Worker answers from its static assets does not count against the Workers request limit ([Workers static assets billing](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/) — re-verify). The dev tier's sites are Workers static assets in the dev account, not Pages ([[infrastructure-as-code#Sites]]).

| Limit | Free value (re-verify) |
|---|---|
| Builds | **500 / month** |
| Concurrent builds | **1** |
| Bandwidth | **Unmetered** (static asset serving is free/unlimited) |
| Custom domains | **100 / project** |
| Files per site | **20,000** |
| Max file size | **25 MiB** |

**Low risk.** Unmetered bandwidth is the main point — the guest site can take a
large traffic spike without a bandwidth bill. The realistic ceiling is **500 builds/month**
(a busy CI day with many pushes) and **20,000 files** (large asset bundles).
Symptom of a build cap: new deploys queue/fail until the month resets — the
**already-deployed** site keeps serving. No app-level fail-closed here.

**Upgrade path:** Pages Pro raises builds to 5,000/mo + 5 concurrent. Rarely
needed for our volume.

---

## Turnstile (Free) — widget live, the cire gate currently inert

**Source:** Cloudflare Turnstile pricing — re-verify when activating (`/turnstile-spin`).

Turnstile is **free with effectively unlimited `siteverify` volume** for the
standard widget — there is no per-verification charge on the free product, so
it is **not a capacity risk** for us. The integration **already shipped** (#154,
`@shared/turnstile` + osn-api register/passkey-login + cire-api claim/RSVP);
full design on [[turnstile]]. It is **key-optional + fail-closed**: with no
secret set the gate is a true no-op (no token expected, the flow runs exactly
as before); with a secret set, every request needs a valid token.

The widget itself is live. `PUBLIC_TURNSTILE_SITEKEY` is a repo Variable and
`deploy.yml` (dev) and `production-release.yml` (production) inject it into the
cire guest-site build and, as `VITE_TURNSTILE_SITEKEY`, the musubi/social build (#160),
so both render a widget. What decides whether the gate bites is
the **Worker secret**.

> **Warning:** once the secret is present, a missing, invalid, duplicate or
> unreachable token rejects the request (400/403). Confirm that the sitekey
> reaching the frontend is the **matching half of the same widget** before you
> set the secret, or every gated form breaks.

**2026-07-20 incident.** A `TURNSTILE_SECRET_KEY` on `cire-api-production` that
did not match the shipped sitekey rejected **every guest claim** with
`403 {"error":"Verification failed. Please try again."}` — guests with a valid
code saw no events. Fix applied:
`bunx wrangler secret delete TURNSTILE_SECRET_KEY --env production`, which
reverts the gate to a no-op; the new Worker version rolled out on its own in
under two minutes, with no redeploy. **The cire gate is inert today because that
secret is absent.** osn-api's secret state is not recorded here — check it with
`bunx wrangler secret list --env production` from `osn/api` before assuming
either way.

To (re-)activate Turnstile:

1. Re-verify that the free tier is still unlimited.
2. Create the managed widget in the CF dashboard, scoped to the hostnames that
   serve the gated forms (`invite.cireweddings.com` for guest claim + RSVP).
3. Set the public sitekey — the repo Variable `PUBLIC_TURNSTILE_SITEKEY` for the
   frontend builds — per the [[production-deploy]] secret checklist.
4. Confirm that sitekey reaches the frontend **and belongs to the same widget as
   the secret you are about to set**.
5. Set `TURNSTILE_SECRET_KEY` (Worker secret) on osn-api and cire-api.
6. Run one real end-to-end claim before trusting the gate.

---

## WAF / Rate Limiting rules (Free)

**Source:** [waf custom-rules](https://developers.cloudflare.com/waf/custom-rules/) · [waf rate-limiting-rules](https://developers.cloudflare.com/waf/rate-limiting-rules/) — re-verify.

| Capability | Free value (re-verify) |
|---|---|
| **Rate Limiting rules** (WAF) | **1 rule**, **10-second window only** |
| **Custom rules** | **5 rules** |
| **Managed ruleset** | **Cloudflare Free Managed Ruleset** (auto-on, no config; subset of the full managed rules) |

**Implication for our design:** with only **1 WAF rate-limiting rule** capped at
a **10-second window**, **we cannot use the WAF for application rate
limiting.** That is why rate limiting lives in the app:

- osn-api → native **Workers** Rate Limiting bindings for its one-minute per-IP
  and per-user limiters, and its coordination store for the rest
  ([[rate-limiting]], [[coordination-store]]).
- cire-api → the native **Workers** Rate Limiting binding `CLAIM_RATE_LIMITER`
  (5 attempts / 60 s) for the pre-auth claim surface — a *Workers* feature,
  distinct from the *WAF* rate-limiting rule counted above.

Reserve the single WAF rate-limit rule + the 5 custom rules for **coarse edge
defence** (e.g. the `/internal/*` block in the hardening TODO below), not for
per-endpoint app limits. Cross-ref [[rate-limiting]] for the full design.

---

## Unavailability response playbook

Per dependency: expected degradation (**verified against code, with file
refs**), the detection signal, and the escalation/upgrade action. **The
fail-open vs fail-closed split is NOT uniform across dependencies — read this
table, don't guess.**

| Dependency down / over-quota | Subsystem | Posture (verified) | Effect | Detect | Action |
|---|---|---|---|---|---|
| **Coordination store** (osn-api's `COORDINATION` Durable Object) failing, or the dev account's Durable Object allowance spent | The auth limiters longer than a minute, the per-account export, deletion and restore limiters, the per-account caps | **fail-CLOSED** — a failed `increment` denies (`createCoordinationRateLimiter`, `shared/coordination/src/client.ts`) | 429 on recovery-code generate and sign-in, emailed-recovery begin, email-change begin, OIDC client registration, account export and deletion | `coordination store call failed` in osn-api's logs; `osn.auth.rate_limited` spike | Wait out a blip; on dev, the 00:00 UTC reset. **Do not** flip to fail-open. |
| ″ | Ceremony stores and their guess counts | **fail-CLOSED** — a failed call is a `CoordinationError`, answered with a generic 503 (`osn/api/src/services/auth/store-call.ts`) | Passkey sign-in and registration, step-up, recovery, email change, TOTP enrolment, cross-device sign-in and the `/authorize` hand-off answer 503 | `coordination store call failed`; `GET /health/coordination` answers 503 | The user-facing one: restore it first. |
| ″ | Step-up token guard | **fail-CLOSED** — a failed `claim` refuses the token as "could not be verified" (`osn/api/src/services/auth/step-up.ts`) | Step-up-gated actions refused | `osn.auth.step_up.verified` drop | Same — the posture is intentional. |
| ″ | Lockout counters (recovery code, emailed recovery code, TOTP) | **fail-CLOSED** — `status` and `recordFailure` answer `"unknown"`; the caller refuses with its generic error and writes no security event (`osn/api/src/lib/coordination/durable.ts`) | Recovery-code sign-in, emailed recovery and TOTP checks refused | `osn.auth.recovery.lockout{result="unavailable"}`, `osn.auth.totp.lockout{result="unavailable"}` | Restore promptly — the owner's own recovery is refused. |
| **D1** down / over daily rows quota (a daily quota binds the dev account only) | cire-api + osn-api | **fail-CLOSED** — cire `index.ts` returns **503** on absent/erroring `env.DB`. osn-api's token refresh writes the new session and its rotation record in one batch and reads the record to detect reuse, so a failed write or read fails the grant, keeps the session marker and revokes nothing (`osn/api/src/services/auth/tokens.ts`) | App-wide 503 on DB routes | CF D1 metrics vs daily line; 503 in Workers Logs | Wait for UTC reset, free storage, or move dev to Workers Paid (D1 paid tier). |
| **A Worker** over daily request quota (dev account only) | osn-api / cire-api | CF edge **429** before handler runs | Site-wide 429 (resets UTC midnight) | account Requests metric vs 100K | Wait for the reset, or move dev to **Workers Paid** ($5/mo). |
| **Pages** build cap | static sites | already-deployed site keeps serving; new deploys queue/fail | stale deploys, build failures | Pages build history | Wait for month reset or Pages Pro. |
| **Durable Objects** over daily quota (dev account only) | realtime push (`@shared/realtime`): cire-api's `REALTIME_HUB` | **fail-SOFT** — `subscribe()` answers 503, `publish()` logs and counts `result="error"` (`shared/realtime/src/server/subscribe.ts`, `publish.ts`) | Tabs stop receiving push and refetch on focus or next request, as before push existed | DO requests/duration vs the daily line in the dashboard; `realtime subscribe failed` and `realtime publish failed` in the product's logs | Wait for the UTC reset, or upgrade to Workers Paid. |

> **Every coordination-store consumer fails closed**, and the rotation records
> in D1 do too. If you change any store's posture, update this table, its file
> ref and [[coordination-store]].

---

## Monitoring

With **Workers observability enabled** on cire-api, cire-invites and osn-api
(the `observability` block of each Worker's Wrangler config, or on dev its
stack declaration), Workers Logs
persist for **3 days** on the Workers Free plan, plus invocation records on
osn-api. Both cire Workers (cire-api in every env, cire-invites) set
`invocation_logs = false`, because an invocation record stores the request URL
and the public cire routes carry the wedding slug. Logs are viewable in the CF
dashboard. The retention and ingestion figures in this section are Workers
Free's, which bind the dev account; production's account is on Workers Paid,
whose allowances are on the same pricing pages.

**Native traces** sample every request on each dev API Worker and the dev
`cire-invites`, and on the production `cire-invites` Worker; Cloudflare keeps
them for **7 days**. The dev static sites and the production API Workers keep
them off ([[tracing]]).

**From 2026-12-01 the ceiling changes shape.** The Free plan's 200,000 log
events a day becomes one **0.5 GB a day** ingestion allowance for the whole
account, shared by every Worker's logs and traces, and log retention rises to 7
days. At the limit Cloudflare stops ingesting until 00:00 UTC: Workers keep
serving, but no Worker writes a log line for the rest of that day. Lower
`observability.traces.head_sampling_rate` first. Nothing watches this
allowance yet — englishstreetventures/osn#1505.

*Figures from Cloudflare's [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/),
[Workers traces](https://developers.cloudflare.com/workers/observability/traces/) and
[Observability pricing](https://developers.cloudflare.com/observability/pricing/) pages, read 2026-10-15.*

- **Where to watch:** CF dashboard → **Workers & Pages → cire-api / osn-api →
  Observability / Logs** (and the Query Builder). D1 + Workers request metrics
  live on each resource's **Metrics** tab. App-level OTel traces/metrics still
  go to Grafana Cloud ([[observability-setup]]) when the OTEL endpoint is set.
- **What to alert on:**
  - **Workers requests** approaching **100K/day** (account-wide) on dev → find
    the traffic, or move dev to Workers Paid.
  - **D1 rows-read / rows-written** approaching the daily lines (5M / 100K) →
    investigate a hot query path or upgrade.
  - **Durable Object requests** approaching **100K/day** on dev (account-wide),
    from cire-api's realtime hub and osn-api's coordination store → check the
    subscribe limits, the ping cost and the store's calls per request; on
    production, the same chart against the month's included million.
  - **`coordination store call failed`** in osn-api's logs, or
    **`osn.auth.rate_limited`** spiking without a traffic spike → the
    coordination store is failing and its consumers are refusing (see playbook);
    expect sign-in failures.
  - Recurring `exceededResources` / `exceededCpu` invocation statuses → a heavy
    request path (e.g. spreadsheet import) bumping the Free CPU/subrequest caps.

**The first two of those are watched for you, on both accounts; the rest are
read by eye.** `.github/workflows/free-tier-ceiling-alert.yml` runs
`scripts/check-free-tier-ceilings.ts --account <production|dev>` at 22:00 UTC
daily, and on demand through `workflow_dispatch` (with `end` and `days` inputs,
so a past day can be replayed), in one job per account. It reads per-day totals
per database and per Worker script from Cloudflare's GraphQL analytics API and
files one issue per account when any counter reaches **80%** of its line:
"Cloudflare free tier: a daily counter is near its ceiling" for production, and
"Cloudflare free tier on the dev account: a daily counter is near its ceiling"
for dev. It reopens and edits its own account's issue rather than opening
another, so a week near the line is one thread, and the body names the account,
the database and the day.

| Job | Environment | Credentials |
|---|---|---|
| `production` | none, so a nightly run needs no approval | the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN_READONLY` |
| `dev` | `dev` (no reviewers) | `CLOUDFLARE_DEV_ACCOUNT_ID` and `CLOUDFLARE_DEV_ACCOUNT_API_TOKEN_READONLY`; either empty fails the job, naming both |

Each read-only token holds `Account Settings: Read`, `D1: Read` and
`Account Analytics: Read` on its own account and nothing else.

Five lines: rows written, rows read and Workers requests per day, plus both
storage lines — 5 GB across the account and **500 MB for any one database** on
dev's Free account, **10 GB** on production's Paid one. The per-database line is
checked per database, not summed, because it is the storage failure that arrives
first: on Free, a 480 MB database has stopped taking writes while the account
total is still a tenth of its 5 GB.

What a line means depends on the account's plan (`PLANS` and `linesFor` in the
script):

| Account | Plan | Caps — something stops | Growth signals — nothing stops |
|---|---|---|---|
| dev | Workers Free | all five | none |
| production | Workers Paid | one database's size, at 10 GB (`PAID_DATABASE_BYTES`) | the three daily lines and the 5 GB account storage line, at Free's figures |

So an issue on production means usage grew, not that anything is about to stop,
unless it names a database's size. Its body says which kind each counter is;
the month's included amounts, past which Paid bills, are under each Upgrade path
above.

Two things to know before trusting it. The figures are the `CEILINGS` and
`PAID_DATABASE_BYTES` constants at the top of that script, and they have to move
whenever the tables above do. And it fails loudly: a bad API response exits
non-zero and fails the run, rather than reporting all-clear.

---

## Cloudflare security hardening (free, dashboard) — TODO

These are **manual dashboard steps** the maintainer must do — current tooling
cannot apply them from code or wrangler. All are free on the Cloudflare Free
plan. They add defence in depth on top of the app-level guards (ARC, origin
guard, auth middleware).

1. **Enable the free WAF Managed Ruleset.** Dashboard → the `cireweddings.com`
   zone → **Security → WAF → Managed rules** → confirm **Cloudflare Free Managed
   Ruleset** is deployed/active (it's on by default, but verify per zone).
2. **Add a free custom rule blocking public `/internal/*` and
   `/graph/internal/*`.** Dashboard → zone → **Security → WAF → Custom rules →
   Create rule**. Expression: `(http.request.uri.path contains "/internal/" or
   starts_with(http.request.uri.path, "/graph/internal/"))` → **Action: Block**.
   This is extra cover on top of ARC — those routes are S2S-only and
   should never be reachable from the public internet. (Costs 1 of the 5 free
   custom rules.)
3. **Enable Page Shield (basic)** on the guest Pages site. Dashboard → zone →
   **Security → Page Shield** → turn on script monitoring — catches unexpected
   third-party scripts on `cire/invites` (the guest invite).
4. **Confirm DDoS protection is on.** Dashboard → zone → **Security → DDoS** →
   verify the automatic L7 HTTP DDoS managed ruleset is enabled (on by default;
   confirm it wasn't disabled).

> When these are done, tick them off here and note the date. Until then they are
> open hardening items — file them in `englishstreetventures/osn-tracker` under
> `area:security` if they should be visible there.

## Related

- [[production-deploy]] — first prod cut-over, secret/var checklist
- [[rate-limit-incident]] — rate-limiter false positives, and which backend a limiter runs on
- [[rate-limiting]] / [[coordination-store]] — app rate-limiting design, and osn-api's shared state on a Durable Object
- [[database-environments]] — the four DB environments (D1 in dev/staging/prod)
- [[observability-setup]] — Grafana Cloud + OTEL wiring
- [[cire-auth]] — cire's two-system auth (what degrades when D1 is down)
- [[realtime]] — the realtime hub, cire's Durable Object class
