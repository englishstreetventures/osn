---
title: D1 Limits
aliases:
  - D1 bound parameters
  - too many SQL variables
  - SQLITE_LIMIT_COMPOUND_SELECT
  - json_each
tags:
  - systems
  - infrastructure
  - database
status: current
related:
  - "[[platform-limits]]"
  - "[[schema-layers]]"
  - "[[backend-patterns]]"
  - "[[social-graph]]"
packages:
  - "@shared/db-utils"
  - "@osn/api"
  - "@pulse/api"
  - "@cire/api"
  - "@zap/api"
last-reviewed: 2026-08-31
---

# D1 Limits

**D1 is not SQLite, and the difference is where our bugs come from.** Nine
production defects were filed in one day because a limit was checked against
SQLite's ceiling instead of D1's. Every one of them passed the whole test suite,
because `bun:sqlite` — which every tier except the `d1-integration.test.ts`
files runs on — enforces none of these.

## The numbers that bite

| What | SQLite | **D1 / workerd** | Source |
|---|---|---|---|
| Bound parameters per query | 999 | **100** | [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) |
| Terms in a compound SELECT (`UNION`, `UNION ALL`) | 500 | **5** | workerd source, `sqlite3_limit(db, SQLITE_LIMIT_COMPOUND_SELECT, 5)` |
| Subrequests to CF services per invocation | — | 1,000 | [[free-tier-limits]] |

**The compound-select limit is documented nowhere by Cloudflare.** It is
compiled into workerd — raised from 3 to 5 in a workerd PR, still 5 at HEAD,
asserted by workerd's own `sql-test.js`. Miniflare reproduces it exactly, so
`bun run test:d1` can see it and nothing else can.

## How the bind cap is reached, and why the second way is missed

Two shapes, and the second is the one that keeps getting overlooked:

- **A `SELECT` binding an id list** — `inArray(col, ids)` binds one parameter
  per element. Cliff around 100 items, or **50** when the same list is bound
  twice (once per branch of an `OR`, which is easy to do accidentally).
- **A multi-row `INSERT`** — `db.insert(t).values(rows)` binds one parameter
  **per column per row**, so it breaks an order of magnitude sooner. A
  31-column table dies at **4 rows**. A 6-column one at 16.

An audit that greps only for `inArray` finds the first and misses the second.
That is exactly what happened: the two worst instances in `pulse/api` — every
recurring series failing at four occurrences, and a GDPR erasure that could
never complete for an account with more than a hundred hosted events — were
both multi-row inserts, and both were missed by an `inArray`-only sweep.

Also count the *whole* statement, not just the list. A literal in a `WHERE`, a
join predicate and a `.limit()` each cost one parameter. `zap/api`'s export cap
is set to exactly 100 ids and one of its two loaders binds **102**.

## The fix: `json_each`

`@shared/db-utils` provides `jsonEachIn` and `insertManyViaJsonEach`. Both bind
the whole array as **one** JSON parameter and unpack it inside SQLite:

```ts
inArray(events.id, jsonEachIn(ids))              // 2 params for 1,000 ids
db.run(insertManyViaJsonEach(events, rows))      // 1 param for 200 rows
```

SQLite flattens `col IN (SELECT value FROM json_each(?))` into a
`LIST SUBQUERY` with a Bloom filter, so the outer query keeps its index seek —
verified with `EXPLAIN QUERY PLAN` at every converted site. It also beat
chunked `.values()` by 7–29× at the two insert sites measured.

Three things it cannot carry, all of which **throw** rather than write wrong
data:

- rows whose key sets differ from the first row's — unlike `.values(rows)`,
  which applies each column's schema default per row;
- an integer outside ±2^53 — JSON numbers are IEEE-754 doubles, so
  `9007199254740993` reads back as `9007199254740992`;
- a blob column — its `Buffer` stringifies to an object `json_extract` cannot
  return to a BLOB.

`json_each` does **not** fit every shape. It cannot carry a per-group `LIMIT`,
because this SQLite build has no implicit `LATERAL` — the organisation
co-member fan-out in `osn/api` needed chunked `UNION ALL` batches instead. And
a correlated `EXISTS` is not an equivalent substitute: on `osn/api` it turned an
index seek into `SCAN c` and read twice the rows for an identical result.

## Rules

1. **A limit justified in a comment must name the engine and say where it was
   measured.** `closeFriends.ts` carried "to stay within SQLite's variable
   limit" — the wrong ceiling, written down as the reason, which is why the bug
   survived every reading of that file.
2. **Never bind per element.** A constant that happens to sit under the cap
   today is not a fix; it is the next bug. Lowering a cap to make a query legal
   usually swaps an error for silent truncation, which is worse.
3. **Verify on `bun run test:d1`.** No other tier enforces any of this. A
   regression test that seeds a realistic fixture is slow and imprecise —
   assert the emitted bound-parameter count with `.toSQL()` instead, with the
   expected figure **derived** from the column list rather than written by hand.
4. **`EXPLAIN QUERY PLAN` works on D1**, but the authorizer blocks some
   builtins: `SELECT sqlite_version()` throws `not authorized to use function`.

## History

| Finding | Where | Cliff |
|---|---|---|
| osn-tracker#589 | `osn/api` FOF fan-out, list bound twice | 51 connections |
| osn-tracker#594 | `pulse/api` series materialisation, 31-col insert | 4 instances |
| osn-tracker#595 | `pulse/api` GDPR erasure, atomic batch | 101 hosted events |
| osn-tracker#590 | `pulse/api` guest invite, insert | ~17 guests |
| osn-tracker#591 | `pulse/api` RSVP list, two queries | 101 attendees |
| osn-tracker#592 | `pulse/api` friends-only discovery, bound twice | ~50 connections |
| osn-tracker#593 | `osn/api` graph-internal batch route | 101 ids (schema says 200) |
| osn-tracker#596 | `zap`/`pulse` export caps | 100 ids binds 102 |
| P-C1 on PR #853 | `osn/api` co-member fan-out, `UNION ALL` arms | 6 organisations |
