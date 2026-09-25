---
title: "One D1 session per request, and always first-primary"
tags:
  - decision
  - cire
  - database
  - performance
related:
  - "[[d1-read-replication]]"
  - "[[backend-patterns]]"
  - "[[cire-development]]"
  - "[[decisions/README]]"
last-reviewed: 2026-09-25
---

# One D1 session per request, and always `first-primary`

`@cire/api` routes every query a request makes through **one D1 session**
(`cire/api/src/db/d1-session.ts`), so read replicas can serve the second and
later queries instead of every query paying the trip to the Oceania primary. The
constraint that session is opened with is **`first-primary`**, Worker-wide.

[[d1-read-replication]] is the reference page: how a session is threaded through
an app graph built once per isolate, the per-query cost that motivates it, the
rules for where a session may be opened, and how replication is turned on. This
page is only the choice and its reasoning.

## The two decisions

| Decision | The alternatives | Why this one |
|---|---|---|
| Open a session at all | One session per request, or an independent `prepare()` per query | Without a session D1 sends every query to the primary. With one, the first query pins the bookmark and the rest can be served by any replica caught up to it — N × (distance to Sydney) collapses to one trip plus N−1 local reads |
| `first-primary` | `first-primary` or `first-unconstrained` | `first-primary` sends the session's first query to the primary, so a request **always observes every write committed before it started**. `first-unconstrained` trades that for one more saved round trip |

## Why not `first-unconstrained`

It gives up ordinary read-your-writes — across requests, not just within one. A
guest who RSVPs and then reloads, or an organiser who saves an edit and then
re-reads it, could be served by a replica that has not caught up.

cire has at least one route that explicitly cannot take that trade:
`cire/api/src/routes/invite.ts` serves a `no-store`, edit-sensitive payload
*precisely so* an organiser's edit surfaces the next time a guest loads the invite.
`first-unconstrained` would reintroduce exactly the staleness that header exists
to prevent.

The constraint is therefore **one value for the whole Worker**, not a per-route
choice. That is the substance of the decision rather than a tidiness preference:
a per-route setting would make read-your-writes a property of which route a
request happened to reach, and nothing at the call site would say so.

## Why it was safe to ship before replication existed

With no replicas, a session behaves exactly as an unsessioned query does — every
query goes to the primary. So the code shipped **inert** and the switch was
flipped separately and reversibly afterwards. [[d1-read-replication]] §It really
is inert without sessions carries the measurement confirming that, with its own
marker.

## What would make this worth revisiting

- A route appears whose latency genuinely matters more than read-your-writes.
  That needs its own session and its own argument in writing — never a change to
  the Worker-wide constant.
- D1 gains a bookmark that can be carried across requests (in a cookie, say), at
  which point a client could prove what it has already seen and
  `first-unconstrained` would stop meaning "may be stale".
- A probe run from Europe or North America puts a real number on what the first
  query's trip to the primary costs, which is the number this trade is being
  made against and is not yet measured.
