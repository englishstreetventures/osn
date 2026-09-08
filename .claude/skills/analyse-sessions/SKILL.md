---
name: analyse-sessions
description: Use when reading the session-performance cards to find where agent effort is going — running the report over `.claude/metrics/`, interpreting it without the traps that have already produced two wrong findings, and reporting what is actually supported. Also the step before proposing any change to how work is dispatched.
---

Analyse the session cards for `$ARGUMENTS`. If it is empty, analyse the whole
corpus.

## What this run must produce

A short written answer naming, for every claim: the number, the sample size it
rests on, and what would have to be true for it to be wrong. Nothing else
counts as an analysis — a table restated in prose is not one.

Never end with a recommendation the data does not carry. "The corpus cannot
answer this yet" is a complete and frequently correct result.

## Why the order below matters

This data has already produced two confident findings that were both wrong, and
both were wrong the same way: a number read without the context that gives it
meaning.

- `cire/host` "spends 62% of its tokens before the first edit — worst in the
  repository". It reads 5% once the metric stops treating an unobserved edit as
  100% exploration. The ranking had been sorted by which branches happened not
  to use the `Edit` tool.
- "Dependency pull requests are 55% of spend for 2 source lines, so batch
  them." Nine of twelve contained a **major** version bump, the isolated majors
  already cost under $6 each, and the discipline being criticised was the
  reason they were cheap.

Both would have been caught by the steps below, in this order.

## Step 0 — Coverage first, before you look at anything else

```bash
bun run --cwd tools/pr-metrics report -- --coverage   # or --json for a consumer
```

Read three things off it and write them down before continuing:

| Read | Because |
|---|---|
| How many cards | A single-digit sample supports no trend at all |
| How many are `confirmed` | Unconfirmed ratings are an agent's own guess, and every difficulty comparison excludes them |
| What share is `at-open` | Those cards are missing review-cycle cost. A remote session's container dies with its transcripts, so its cards stay `at-open` forever and the corpus under-reports |

If nothing is rated, say so at the top of your answer. Most of the interesting
questions are unanswerable without it, and offering the answerable ones as
though they were the whole picture is how a partial view becomes a wrong one.

## Step 1 — Run what you need, not everything

```bash
bun run --cwd tools/pr-metrics report                  # all seven analyses
bun run --cwd tools/pr-metrics report -- --waste       # one of them
bun run --cwd tools/pr-metrics report -- --json        # structured, for an agent
```

`--json` carries each table's `note` alongside its rows. **The note is not
decoration** — it holds the exclusions. A consumer that reads only rows will
state a ranking's conclusion without its "18 cards excluded" qualifier, which
is precisely the `cire/host` failure repeated by a different route.

For a question the seven do not cover, `tools/pr-metrics/queries.sql` is the
same data in SQL — but DuckDB is local-only, so never assume it in a remote
session.

## The four traps

**1. Never call spend "waste" without the declared complexity.** These two look
identical in every column except one:

| Diff | Declared | Spend | What it is |
|---|---|---|---|
| Small | Low | High | Waste — worth acting on |
| Small | **High** | High | A hard problem that ended in a one-line fix — leave it alone |

Unrated work supports neither reading. Say "unrated, so I cannot tell" rather
than defaulting to the accusation.

**2. Median, never mean, and never a share whose denominator might be
unknown.** The per-pull-request distributions are severely right-skewed —
median 3.6M tokens against a mean of 15.4M and a maximum of 92.7M. A mean
describes the largest two or three pull requests and invents month-over-month
growth that is not there. `explore_share` is `null` when no edit was observed;
exclude those cards and report how many you excluded.

**3. Classify before aggregating.** "Dependency PR" is not one thing. Check
what actually changed rather than trusting the branch name:

```bash
gh pr diff 882 --repo xchromo/osn --patch | grep -E '^[+-]\s*"[^"]+":\s*"[\^~]?[0-9]'
```

A major bump legitimately costs more than a patch sweep. The same applies to
any grouping you are about to average over — docs, tests and generated files
are already separate buckets in the card for this reason.

**4. Correlation is not the finding.** Session count tracks cost almost
perfectly (1–2 sessions ≈ $3 per pull request, 5–7 ≈ $32). Harder work also
takes more sessions, so the number alone does not say restarts are wasteful.
Look for the discriminator — here, how many hit a compaction: if few did, most
restarts were not forced by context exhaustion, and *that* is the finding.

## Step 2 — Report

For each claim: the number, the sample it rests on, the exclusions, and the
one thing that would overturn it. Rank by what is actionable, not by what is
surprising.

Where the data supports a change to how work is dispatched, hand it to
`pick-agent` rather than deciding here — this skill measures, that one chooses.

## What consumes this

`wiki/observability/session-metrics.md` holds the schema and the reasoning
behind every field. `tools/pr-metrics/README.md` has the commands. Cards are
written by `prep-pr` and by the `SessionEnd` hook, so a branch worked entirely
in a remote session still has one.
