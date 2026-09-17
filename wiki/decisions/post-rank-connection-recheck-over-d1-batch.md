---
title: "Post-rank re-check instead of a D1 batch"
tags:
  - decision
  - d1
  - social-graph
  - correctness
related:
  - "[[social-graph]]"
  - "[[d1-limits]]"
  - "[[decisions/README]]"
last-reviewed: 2026-09-17
---

# Post-rank re-check instead of a D1 batch

The connection recommender reads the caller's own edges (step 1) and fans out
(step 2) in two separate, un-transacted D1 round trips. A bounded re-check after
ranking (step 4.5) fixes the race between them, rather than joining the two
reads into one `db.batch()`.

The code is `osn/api/src/services/recommendations.ts`.

## The race

Step 1 snapshots the caller's edges into `myEdgeRows`; step 2's friend-of-friend
seed subquery re-reads `connections` live. If a connection is accepted for the
caller in that window — the same account, a second request in flight from
another tab or device — its id was never seen by `myEdgeRows`, so it is in
neither `myConnectionIdSet` nor `excludeIds`, but it *is* inside the live seed
subquery's result. Step 3 then misfiles the fan-out row as a candidate and the
caller's own brand-new connection comes back as "someone you may know".

`profileId` is always the caller's own, so this can only misfile the owner's
freshest edge against themselves — it never leaks or block-bypasses another
account's state.

## The alternatives

| Option | Why not |
|---|---|
| `db.batch()` across steps 1 and 2 | Rejected without running it. D1's docs do not state that a batch is snapshot-isolated against a concurrent write from a *different request*, and a fix resting on that would be correct only if the guarantee holds |
| A real transaction | D1 has no cross-request transaction to reach for here; see [[database-environments]] for the driver seam and its caveat |
| Re-read fresh after ranking | What shipped |

## What made the difference

A bounded re-check needs no assumption about the engine: it is correct whether
or not D1 batches are isolated. It costs one extra pair of round trips to stop
depending on an unverified guarantee — and this file has already been burned
three times by taking an engine property on faith instead of measuring it (see
the comments on `MAX_MY_CONNECTIONS_FOR_FOF` and
`MAX_ORG_COMEMBER_ARMS_PER_QUERY`, and
[[org-comember-fanout-batched-union]]).

The re-check is cheap because it runs *after* ranking, over at most `safeLimit`
(≤ 50) ids, so it cannot reopen the 100-bound-parameter cap.

## The bind shape is not incidental

Filtering naively with `or(inArray(requesterId, ids), inArray(addresseeId,
ids))` binds the id list **twice** — the same mistake the fan-out already exists
to avoid. At `safeLimit`'s ceiling of 50 that is 102 parameters (2 `profileId`
equality binds + 2 × 50-id `inArray`s), over D1's 100-per-statement cap, checked
against `.toSQL()` rather than reasoned about.

Each query instead runs the id filter once, against a subquery projecting the
counterpart id itself: 3 `profileId` binds (one in the `CASE`, two in the seed
`WHERE`) + up to 50 for the single `inArray` = **53 parameters**, confirmed the
same way. See [[d1-limits]].

No status filter on the connections re-check — any row, pending or accepted,
means "no longer a suggestion", the same way `excludeIds` already treats every
edge rather than only accepted ones.

## No backfill, and that is a choice

A candidate dropped by the re-check is not replaced from the next rank down.
Backfilling would need re-ranking against a larger candidate pool, which is a
recall decision rather than this fix's job. The caller sees a list one entry
shorter on the rare request that races its own second tab, never a wrong one.

## What would make this worth revisiting

- Cloudflare documents D1 batch isolation against concurrent writes, which would
  make the one-round-trip form defensible — measure it before trusting it.
- The one-entry-short list becomes a complaint, which turns backfill into a
  recall question worth answering properly rather than a patch here.

Related: [[social-graph]] for the recommendation pipeline.
