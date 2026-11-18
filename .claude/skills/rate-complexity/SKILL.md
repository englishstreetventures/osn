---
name: rate-complexity
description: Use when an issue needs its complexity declared — reading the issue body alone and applying a rating without asking the owner, or backfilling a rating onto an existing unrated issue. Invoked by write-issue on every issue it opens and by new-feat on an unrated issue it picks up; also the backfill path for issues opened before the label existed.
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

## Mode A — the normal path (the owner has delegated approval)

Used by `write-issue` on every issue it opens, and by `new-feat` on an unrated issue it picks up. The owner has delegated the approval: rate it and apply the label, and never ask them to confirm or amend it.

1. Read the issue body — **only** the body. Not the branch, not the code, not
   the conversation that led to it.
2. Choose one number, and write one sentence of justification naming the rubric row where the report or the issue thread will show it.
3. Apply the label, with no `complexity:unconfirmed`:

```bash
gh issue edit 412 --repo englishstreetventures/osn --add-label "complexity:3"
```

Rate before any work starts and before any cost is on screen, as above. A rating
made after the work has begun is contaminated: add `complexity:unconfirmed` to it
and say so.

## Mode B — backfill (no owner)

Used to rate issues opened before the label existed. Rate from the body alone,
apply both labels, and never ask:

```bash
gh issue edit 412 --repo englishstreetventures/osn --add-label "complexity:3,complexity:unconfirmed"
```

Do them in one pass over a listing, not one conversation per issue:

```bash
gh issue list --repo englishstreetventures/osn --state all --limit 200 \
  --json number,title,body,labels \
  --jq '[.[] | select((.labels | map(.name) | map(startswith("complexity:")) | any) | not)]'
```

## The labels

Six, on both `englishstreetventures/osn` and `englishstreetventures/osn-tracker`:

| Label | Meaning |
|---|---|
| `complexity:1` … `complexity:8` | The declared rating (1, 2, 3, 5, 8) |
| `complexity:unconfirmed` | Rated by backfill, or after the work had begun, so it cannot serve as a denominator |

An issue with a rating and no `complexity:unconfirmed` was rated from its body
before work began, by the owner or by an agent the owner has delegated to. Exclude unconfirmed ratings from any query you intend to act on:

```bash
gh issue list --repo englishstreetventures/osn --label "complexity:1" --search "-label:complexity:unconfirmed"
```

## What consumes this

`@tools/pr-metrics` reads the label into `complexity.declared` on the card —
from this repository's issues, and from tracker issues for a pull request that
links none here — and `wiki/conventions/session-metrics.md` holds the queries
that use it. That page
also carries the rule this skill exists to protect: the card stores exactly one
scalar judgement, and this is it.
