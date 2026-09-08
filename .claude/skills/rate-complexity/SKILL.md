---
name: rate-complexity
description: Use when an issue needs its complexity declared — proposing a rating from the issue body alone and getting the owner to confirm or amend it, or backfilling a rating onto an existing unrated issue. Invoked by new-feat at issue-creation time; also the backfill path for issues opened before the label existed.
---

Declare how hard an issue is, **before anyone starts work on it**.

## Why the timing is the whole point

The rating is the denominator in every session-metrics query: spend is compared
against it to find work that cost far more than it should have. That comparison
only means anything if the rating was made in ignorance of what the work turned
out to cost.

So the rating happens **at issue time**, never at pull-request time. A rating
made while a token total is on screen is contaminated — the number gets talked
into agreeing with the spend, and the metric quietly starts confirming whatever
already happened. If you find yourself rating an issue whose branch has already
been worked, say so and mark it unconfirmed rather than pretending.

Two other things you must not do:

- **Never let the agent that did the work rate the work.** It will rate the task
  it struggled with as hard. That is motivated reasoning, and it corrupts the
  one field the whole system rests on.
- **Never rate from the diff.** The diff does not exist yet, and it is the wrong
  evidence anyway — see the rubric.

## The rubric

Fibonacci, so that the ratio `cost ÷ complexity` is a real division. Rate the
**problem**, not the change it will produce.

| | Shape |
|---|---|
| **1** | One file, no new behaviour. A copy change, a version bump, a label on an existing guard. |
| **2** | One package, following a pattern already in the repository. A route that mirrors an existing route, a test for existing code, a wiki page. |
| **3** | One package, but something has to be designed. A new service, a schema change with a migration, a component with real states. |
| **5** | Several packages, or one package plus a contract others depend on. A shared util two apps adopt, a change to an auth path, anything touching sessions or tokens. |
| **8** | Cross-cutting, or the shape is unknown at the start. A migration across the monorepo, a new subsystem, anything whose first task is working out what the task is. |

> [!important] A small change is not the same as an easy problem.
> A one-line fix to a race condition is not a 1. A four-hour debug that ends in
> a deleted character is a 5 or an 8. Rate the difficulty of *knowing what to
> do*; the size of the eventual diff is recorded separately and on purpose.

Signals that raise a rating: the cause is unknown; it touches auth, sessions,
tokens or a migration; it changes a contract another package imports; it needs a
decision nobody has made yet. Signals that lower one: an identical change exists
in the repository already; the issue body names the file and the fix.

## Mode A — with the owner (the normal path)

Used by `new-feat` on an issue being opened or picked up.

1. Read the issue body — **only** the body. Not the branch, not the code, not
   the conversation that led to it.
2. Propose one number and one sentence of justification naming the rubric row.
3. Ask the owner to confirm or amend, offering the neighbouring values.
4. Apply the label they land on:

```bash
gh issue edit 412 --repo xchromo/osn --add-label "complexity:3"
```

If the owner is not reachable — an unattended run — apply the rating **and**
`complexity:unconfirmed`, then carry on. A rating nobody confirmed is still far
better than none; the marker keeps it separable in queries.

## Mode B — backfill (no owner)

Used to rate issues opened before the label existed. Rate from the body alone,
apply both labels, and never ask:

```bash
gh issue edit 412 --repo xchromo/osn --add-label "complexity:3,complexity:unconfirmed"
```

Do them in one pass over a listing, not one conversation per issue:

```bash
gh issue list --repo xchromo/osn --state all --limit 200 \
  --json number,title,body,labels \
  --jq '[.[] | select((.labels | map(.name) | map(startswith("complexity:")) | any) | not)]'
```

## The labels

Six, on both `xchromo/osn` and `xchromo/osn-tracker`:

| Label | Meaning |
|---|---|
| `complexity:1` … `complexity:8` | The declared rating (1, 2, 3, 5, 8) |
| `complexity:unconfirmed` | No human signed off on it — an agent's rating, standing alone |

An issue with a rating and no `complexity:unconfirmed` was confirmed by the
owner. Exclude unconfirmed ratings from any query you intend to act on:

```bash
gh issue list --repo xchromo/osn --label "complexity:1" --search "-label:complexity:unconfirmed"
```

## What consumes this

`@tools/pr-metrics` reads the label into `complexity.declared` on the card, and
`wiki/observability/session-metrics.md` holds the queries that use it. That page
also carries the rule this skill exists to protect: the card stores exactly one
scalar judgement, and this is it.
