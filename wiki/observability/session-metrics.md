---
title: Session Metrics
aliases:
  - PR metrics
  - session performance cards
  - agent cost tracking
tags:
  - observability
  - conventions
  - ops
status: current
related:
  - "[[observability/overview]]"
  - "[[observability/metrics]]"
  - "[[conventions/review-findings]]"
  - "[[conventions/stacked-prs]]"
last-reviewed: 2026-09-07
---

# Session Metrics

Every pull request gets a **card**: a JSON record of what the agent session that
produced it cost, what it changed, and how much steering it needed. Cards live
at `.claude/metrics/<branch-slug>.json`, one file per branch, committed in the
pull request they describe.

The point is not to spend less. A hard task should cost more than an easy one,
and a card that only said "this PR cost $58" would be a number nobody could act
on. The point is the comparison: **spend against a difficulty declared before
anyone knew what the work would cost.** Where those two disagree, something is
wrong — usually a missing skill, an unclear brief, or a wiki page that does not
exist yet.

## The one rule about scoring

> [!important] The card holds exactly one scalar judgement: `complexity.declared`.
> Everything else — lines, files, tokens, turns — is stored raw.

There is no composite "complexity score" derived from the diff, and adding one
would break the metric. A blended number cannot tell these two apart:

| Diff | Declared | Spend | Verdict |
|---|---|---|---|
| Small | Low | Huge | Waste — this is what we are hunting |
| Small | High | Huge | A hard debug that ended in a one-line fix — fine |

Any formula that folds diff size into difficulty collapses those into one row,
and the metric then punishes the hardest legitimate work in the repository. So
outliers are a **query over raw fields**, never a stored field.

## Where the data comes from

Claude Code writes a transcript per session under
`~/.claude/projects/<encoded-cwd>/`, and stamps `gitBranch` on every assistant
message. That field is the whole join: this repository runs one worktree and one
branch per task, so a branch name maps to exactly one pull request.

Two traps the collector handles and any reimplementation must:

- **Subagent spend is in a sibling directory**, `<session-id>/subagents/*.jsonl`,
  not in the main transcript. Missing it under-reports every delegated task, and
  on orchestrated work that is most of the cost.
- **Most `role: "user"` records are machinery** — tool results, hook output,
  system reminders, slash-command envelopes. Counting them destroys `user_turns`
  as a measure of steering.
- **A prompt typed while the agent is working is not a `user` record at all.**
  It arrives as `type: "attachment"` with `attachment.type === "queued_command"`
  and the text under `attachment.prompt`. This is the one that matters most: a
  message sent mid-flight *is* a course correction, so reading only `user`
  records scores every interruption as zero and makes `corrective_turns` report
  the opposite of what it claims. There were 354 such prompts in this
  repository's transcripts when the collector was written. About 2% are also
  echoed back as a `user` record once dequeued, so a queued/user pair with the
  same text in the same session is collapsed — but two identical `user` turns
  are never collapsed, because a person who types "continue" twice steered
  twice.

`~/.claude/projects/` is local and unversioned, so a card can only be generated
on the machine that did the work. Once written it is committed, which is what
makes the history durable.

## Schema

`schema_version` is `1`. Bump it when a field changes meaning or leaves.

| Field | Meaning |
|---|---|
| `pr.number`, `pr.branch`, `pr.base_sha`, `pr.head_sha` | Identity |
| `pr.phase` | `at-open` or `at-merge` — see [[#Two phases]] |
| `issue.number`, `issue.type`, `issue.labels` | The issue this implements |
| `complexity.declared` | 1, 2, 3, 5 or 8 — the only judgement in the file |
| `complexity.method` | How that number was arrived at |
| `window.sessions` | Distinct sessions on this branch |
| `window.span_seconds` | First to last timestamp, idle included |
| `window.active_seconds` | Per-message gaps, each capped at 300s, summed per session |
| `window.compactions` | Context refills — a floor, not an exact count |
| `spend.usd_equivalent` | List API rates. **Not a bill** — see below |
| `spend.tokens` | `input`, `output`, `thinking`, `cache_write_5m`, `cache_write_1h`, `cache_read` |
| `spend.by_model`, `spend.by_actor` | Same totals split by model, and by main thread vs subagent |
| `spend.unpriced_models` | Models with no rate in the table; their cost reads as zero |
| `diff.files`, `diff.loc` | Counts bucketed `source` / `test` / `docs` / `config` / `generated` |
| `diff.packages` | Workspace directories touched |
| `interaction.user_turns` | Real human instructions |
| `interaction.corrective_turns` | Human turns arriving *after* the agent started work |
| `interaction.tokens_before_first_edit` | Exploration cost, summed per session |
| `interaction.edit_churn` | `files_edited_3plus`, `max_edits_one_file` |
| `interaction.skills`, `interaction.subagents`, `interaction.tool_calls` | Histograms |

### On `usd_equivalent`

List API rates, applied to real token counts: input, output, cache writes at
1.25x input (2x for the 1h TTL), cache reads at 0.1x. This work runs on a
subscription, so **the figure is not money owed.** It is a unit of effort
comparable across models, which is all a card needs. A model with no entry in
the rate table prices at zero rather than guessing, and is named in
`spend.unpriced_models` so the gap is visible rather than silent.

### Two phases

A card written when the PR opens cannot see review-cycle cost. `phase` says
which you are looking at:

- `at-open` — written by `prep-pr`, covers work up to the pull request.
- `at-merge` — rewritten after merge, includes review fixes.

Filter on `phase` in any query that compares totals, or a merged PR and an open
one will not be measuring the same thing.

## The two fields that name a cause

Most of the card describes cost. Two fields point at what to *do*, one per
lever:

**`tokens_before_first_edit` → a missing skill or wiki page.** Everything spent
before the first `Edit` or `Write` is the agent working out where the code
lives. It is summed per session, so a second session re-orienting from scratch
is charged again rather than hidden behind the first session's answer.
Repeatedly high in one area means that area has no usable map.

**`corrective_turns` → an unclear brief.** Human turns that arrive after the
agent has already picked up tools: course corrections rather than the task. One
turn and a large spend is an agent given a clear brief. Nine turns is a brief
that needed nine patches. This is the one number here that measures the person
rather than the model.

Two supporting signals: a rising **cache-read share** across PRs means the
context surface — `CLAUDE.md`, the skills, the wiki pages an agent opens — is
bloating; and **`edit_churn.max_edits_one_file`** separates an agent that was
lost from one that was building.

## Running the collector

```bash
bun run --cwd tools/pr-metrics card                              # current branch
bun run --cwd tools/pr-metrics card -- --pr 908 --issue 895      # with identity
bun run --cwd tools/pr-metrics card -- --branch feat/x --base origin/main
```

The package is `@tools/pr-metrics`; `tools/pr-metrics/README.md` is its entry
point and points back here.

| Flag | Default |
|---|---|
| `--branch` | Current branch. Refuses `main` |
| `--base` | `origin/main` |
| `--sessions-dir` | `~/.claude/projects` |
| `--out-dir` | `.claude/metrics` |
| `--pr`, `--issue`, `--issue-type`, `--issue-labels` | Unset |
| `--complexity`, `--complexity-method` | Unset |
| `--phase` | `at-open` |

It never fails on missing transcripts — a card with a diff and zero spend is
still a true record, and it warns on stderr rather than exiting non-zero.

## Querying the cards

The committed files *are* the datalake. DuckDB reads them where they sit, so
there is no service to run and no free-tier cap to watch:

```sql
CREATE VIEW cards AS
  SELECT * FROM read_json_auto('.claude/metrics/*.json', union_by_name := true);
```

**Where agents cost too much for the job** — the query this whole system exists
for:

```sql
SELECT pr.number, complexity.declared, diff.loc.source.added,
       spend.usd_equivalent, interaction.user_turns
FROM cards
WHERE complexity.declared <= 2
  AND diff.loc.source.added < 100
  AND pr.phase = 'at-merge'
ORDER BY spend.usd_equivalent DESC
LIMIT 20;
```

**Where a skill or wiki page is missing** — exploration cost as a share of the
whole, by package:

```sql
SELECT unnest(diff.packages) AS package,
       count(*) AS prs,
       avg(interaction.tokens_before_first_edit
           / nullif(spend.tokens.output + spend.tokens.cache_read, 0)) AS explore_share
FROM cards
GROUP BY 1
HAVING prs >= 3
ORDER BY explore_share DESC;
```

**Whether briefs are getting clearer** — corrective turns over time:

```sql
SELECT date_trunc('month', pr.generated_at::TIMESTAMP) AS month,
       avg(interaction.corrective_turns) AS avg_corrections,
       avg(interaction.user_turns) AS avg_turns
FROM cards
GROUP BY 1 ORDER BY 1;
```

**Whether the context surface is bloating** — cache-read share by month:

```sql
SELECT date_trunc('month', pr.generated_at::TIMESTAMP) AS month,
       avg(spend.tokens.cache_read
           / nullif(spend.tokens.cache_read + spend.tokens.cache_write_5m
                    + spend.tokens.cache_write_1h + spend.tokens.output, 0)) AS cache_read_share
FROM cards
GROUP BY 1 ORDER BY 1;
```

## What this is not

Cards are not the live dashboard. Claude Code's own OpenTelemetry exporter
(`CLAUDE_CODE_ENABLE_TELEMETRY=1`) emits `claude_code.token.usage`,
`claude_code.cost.usage`, `claude_code.active_time.total`,
`claude_code.subagent.spawn` and more into Grafana Cloud, and that is the right
surface for a fleet-wide trend. It carries no branch, so it cannot answer "what
did this pull request cost" — which is what cards are for. Run both.

## Related

- [[observability/overview]] — the three observability rules
- [[conventions/review-findings]] — where a finding from a card gets filed
