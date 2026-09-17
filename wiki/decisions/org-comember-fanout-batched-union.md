---
title: "Org co-member fan-out: batched UNION ALL with a per-organisation LIMIT"
tags:
  - decision
  - d1
  - performance
  - social-graph
related:
  - "[[social-graph]]"
  - "[[d1-limits]]"
  - "[[decisions/README]]"
last-reviewed: 2026-09-17
---

# Org co-member fan-out: batched `UNION ALL` with a per-organisation `LIMIT`

`GET /recommendations/connections` pulls candidates from the organisations the
caller belongs to. That fan-out is built as batched `UNION ALL` arms — one
statement per group of up to `MAX_ORG_COMEMBER_ARMS_PER_QUERY` (5)
organisations, run concurrently and merged in application code — with each arm
carrying its own `ORDER BY profile_id LIMIT <share>`.

The per-group `LIMIT` is the load-bearing part. Batching only changes how many
round trips it takes; it does not change which organisations contribute or how
many rows are read.

The code is `osn/api/src/services/recommendations.ts`.

## The problem it answers

A single global `ORDER BY (organisation_id, profile_id) LIMIT
MAX_ORG_COMEMBER_ROWS` spends the whole budget on whichever organisations sort
first. Organisation ids are random but fixed per caller, so the same few win
every request, forever, and every other organisation the caller belongs to
contributes nothing.

## The alternatives

| Option | Why not |
|---|---|
| One global `ORDER BY … LIMIT` | The starvation above. Bounded reads, wrong recall |
| `ROW_NUMBER() OVER (PARTITION BY organisation_id ORDER BY profile_id)` filtered to `rn <= share` — what the issue reporting the starvation proposed | A window function's `PARTITION BY` filters *after* the window scan, so it still reads every membership row of every organisation the caller belongs to. That is exactly the unbounded read `MAX_ORG_COMEMBER_ROWS` exists to prevent |
| `json_each()` — one statement carrying the whole organisation list as a bound JSON array | D1 does expose the function (confirmed against Miniflare), but it does not fit this shape: giving each organisation its own `ORDER BY … LIMIT <share>` needs a per-row-correlated subquery in the `FROM` clause, and this SQLite build has no implicit `LATERAL` (`no such column: je.value`, confirmed against Miniflare rather than assumed). It stays useful elsewhere for a flat `IN`-style list past the 100-bound-parameter cap; it does not replace a per-group `LIMIT` |
| One `UNION ALL` statement with all 50 arms | Correct in `bun:sqlite`, fails on D1: workerd caps a compound `SELECT` at 5 terms. See [[d1-limits]]. This is what the batching fixes, and it fixes nothing else |

## What made the difference

Only the per-group `LIMIT` both stops one organisation starving the others and
keeps rows read bounded. The window function gets the first and loses the
second:

> Measured on real (Miniflare/workerd) D1, three organisations of 600/300/100
> members, cap 150, share 50: the single global query read **151 rows** for 150
> results, and the window function read **2,860** for the same 150. Both the
> single-statement `UNION ALL` and the batched form read exactly **150** —
> batching changes round-trip count, not rows read.

*Unverified — the method is on record, the date is not. Re-run it against the
D1 tier in `osn/api/tests/d1/`, which is the only place `rows_read` is visible
at all.*

A single organisation with 50,000 members would still cost the window function
50,000+ rows read on every request, forever — the same failure
`MAX_ORG_COMEMBER_ROWS` was added to stop.

## The share, and the remainder

The share is `MAX_ORG_COMEMBER_ROWS` divided evenly by the caller's *actual*
organisation count — not by the 50-organisation cap and not by the batch size.
A caller in one organisation gets the whole budget, a caller in three splits it
three ways, and a caller at the cap gets a 40-per-organisation worst case.

Integer division leaves a remainder of at most `myOrgIds.length - 1` rows of
budget, and it goes to no organisation. Handing it to whichever organisation
sorts first would reintroduce, in miniature, the exact bias this shape exists to
remove.

## Two engine facts the shape depends on

- **Each arm is wrapped as a subquery** (`.as(...)`, then an outer
  `.select().from(...)`). SQLite's compound-select grammar gives a non-final
  `UNION ALL` arm no `ORDER BY`/`LIMIT` of its own — only a derived table gets
  one. The unwrapped form is a syntax error ("ORDER BY clause should come after
  UNION ALL not before"), confirmed against a real SQLite engine rather than
  assumed.
- **`myOrgIds` is sorted once, up front**, and cut into batches in that order,
  so the merged result reproduces `(organisation_id, profile_id)` order.
  `Effect.all` returns results in input order whichever batch resolves first, so
  that survives the concurrency. Step 3's "first organisation wins the label" is
  deterministic across requests only because of this.

## What would make this worth revisiting

- workerd raises `SQLITE_LIMIT_COMPOUND_SELECT` above 5, which would collapse
  the batching back into one statement — the per-group `LIMIT` would not change.
- This SQLite build gains an implicit `LATERAL`, which would make the
  `json_each()` form expressible in one statement.
- Recall, rather than fairness, becomes the complaint. The budget split is a
  fairness decision; raising `MAX_ORG_COMEMBER_ROWS` is the lever for recall, and
  it is bounded by what a request may read.

Related: [[social-graph]] for the recommendation pipeline, [[d1-limits]] for the
compound-select and bound-parameter caps.
