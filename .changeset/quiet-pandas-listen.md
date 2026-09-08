---
"@tools/pr-metrics": minor
---

Put cards in front of people: a PR-body block, a backfill for merged pull requests, and the queries that read the cards back.

`--format markdown` renders the card as a collapsed `<details>` block for a pull-request body, and `prep-pr` now appends one after `## Test plan`. It is a `<details>` block rather than a section because that skill permits exactly five `##` headings and checks the count — a metrics section would fail a body that is otherwise correct.

`bun run --cwd tools/pr-metrics backfill` writes cards for pull requests that merged before cards existed. A merged branch is usually deleted, so the file list comes from the GitHub API rather than a local diff; spend still comes from local transcripts, and a pull request with none is skipped rather than written as zero, because a zero-cost card is indistinguishable from a genuinely cheap one once it is in the datalake.

`queries.sql` defines the `cards`, `merged` and `metrics` views and seven queries: where agents cost too much for the job, which packages need a skill or a wiki page, whether briefs are getting clearer, whether the context surface is bloating, cost per unit of declared difficulty, whether delegation pays off, and how much of the history can be trusted at all.
