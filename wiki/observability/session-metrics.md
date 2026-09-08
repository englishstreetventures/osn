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
last-reviewed: 2026-09-08
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

## Declaring complexity

The rating lives on the **issue**, as a `complexity:` label, and it is set
**before work starts** — `/new-feat` does it at Step 0 through the
[[rate-complexity]] skill, which proposes a number from the issue body alone and
asks the owner to confirm or amend it.

The timing is not a detail. A rating made at pull-request time, with a token
total already on screen, gets talked into agreeing with whatever the work cost,
and the metric then confirms every outcome instead of questioning any of them.
For the same reason the agent that did the work never rates the work: it will
score the task it struggled with as hard.

| Label | Meaning |
|---|---|
| `complexity:1` | One file, no new behaviour |
| `complexity:2` | One package, following a pattern already here |
| `complexity:3` | One package, but something must be designed |
| `complexity:5` | Several packages, or a contract others depend on |
| `complexity:8` | Cross-cutting, or the shape is unknown at the start |
| `complexity:unconfirmed` | An agent's rating that no human signed off on |

Fibonacci, so `usd_equivalent ÷ declared` is a real division. The rubric rates
the **problem**, not the change: a one-line fix to a race condition is not a 1.
Diff size is recorded separately, on purpose, and the two are never blended.

Exclude unconfirmed ratings from anything you intend to act on — they are an
agent's guess standing alone, and mostly arrive from the backfill of issues that
predate the label.

## Where the data comes from

Claude Code writes a transcript per session under
`~/.claude/projects/<encoded-cwd>/`, and stamps `gitBranch` on every assistant
message. For a session that runs in its own task worktree that field is the
join: this repository runs one worktree and one branch per task, so a branch
name maps to exactly one pull request. For delegated work it is not enough —
see [[#Attributing subagent spend]].

Three traps the collector handles and any reimplementation must:

- **Subagent spend is in a sibling directory**, `<session-id>/subagents/*.jsonl`,
  not in the main transcript. Missing it under-reports every delegated task, and
  on orchestrated work that is most of the cost.
- **One conversation is sometimes written into two session files.** 615 assistant
  records on this machine — 5.2% of session spend — appear in both, and reading
  them twice doubles the branch's cost. `readRecordsForBranch` keys on
  `requestId` and returns each once.
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

## Attributing subagent spend

`gitBranch` is a property of the **session**, captured once when it starts and
inherited by every subagent. A subagent working in a task worktree therefore
records the branch its *parent* started on, and `isolation: "worktree"` does not
help — it pins the subagent's `cwd` and still reports the parent's `gitBranch`.

The scale, measured over 904 transcript files and 9.03e9 tokens:

| Where the spend sits | Share |
|---|---|
| Stamped `HEAD` (the bare-repo root) | 62.4% |
| Stamped `main` | 12.1% |
| A real branch | 25.5% |

Subagent transcripts are 27.0% of all spend, and **85.8% of that is stamped
`HEAD`** against 7.4% on a real branch. A branch whose work was delegated saw
almost none of its own cost.

So `orchestrate` puts a marker on its own line at the top of every dispatch
prompt:

```
TASK-BRANCH: feat/example
```

`resolveDispatchBranch` in `tools/pr-metrics/index.ts` reads it back. Every
subagent transcript has a sibling `agent-<id>.meta.json` carrying the
`toolUseId` of the `Agent` call that spawned it; that id appears on the
`tool_use` block in the parent transcript, whose `input.prompt` is the dispatch.
The marked branch then replaces `gitBranch` for every record in that file.

Three things about it worth keeping:

- **The parent may be another subagent.** `spawnDepth: 2` is 79 of this
  machine's 363 subagent files, 8.3% of subagent spend, and every one of those
  parents is a sibling `subagents/*.jsonl` rather than the session file.
- **A child with no marker inherits its parent's branch.** Depth-2 prompts are
  written by `stress-plan`, `prep-pr` and
  `superpowers:subagent-driven-development` — the last a plugin this repository
  cannot edit — so requiring a marker everywhere would lose their spend.
- **Nothing enforces the marker.** It is a line a skill instructs an agent to
  write, so `card` counts the subagent files that resolve to nothing under a
  `main`/`HEAD` session and warns. A forgotten marker shows up on the next card
  instead of silently under-reporting.
- **A marker is never sufficient on its own.** `~/.claude/projects` holds every
  project on the machine, and a card is committed to a public repository
  carrying `tool_calls`, `skills` and `subagents` keyed verbatim from the
  transcript — MCP server and private skill names among them. So a marked
  transcript is admitted only from a project directory this repository owns,
  derived from `git worktree list` and the common git dir. Two checkouts sharing
  a branch name is a collision, not an attack, and it must not publish one
  project's metadata from the other.
- **The marker is read from the first three lines**, and the value has to look
  like a ref. Dispatch prompts quote text nobody here wrote — issue bodies,
  review comments, fetched pages — and a planted `TASK-BRANCH:` line further
  down would otherwise re-point a subagent's whole spend onto another card.

This is **forward-looking only**. Historical transcripts carry no marker, so the
85.8% stays where it is; the fix changes what new work records, not what old
work recorded.

A wholly delegated card reports zero `user_turns` and "not observed" for first
edit by construction — those skip sidechain records. The steering for
orchestrated work lives in the orchestrator's own session, which is deliberately
not carded: a session that only dispatches is not one task's cost.

`~/.claude/projects/` is local and unversioned, so a card can only be generated
on the machine that did the work. Once written it is committed, which is what
makes the history durable.

### Remote sessions

Nothing extra is needed. Every session — local, cloud, another machine — has its
own transcripts, cards its own branch, and commits the JSON with the branch. The
repository is the aggregation point, so a central service would only duplicate
what the repository already does for a few hundred rows a year.

One thing does need care: a remote container is destroyed when the session ends
and takes its transcripts with it, and a card that was never written is gone for
good. So a **`SessionEnd` hook in `.claude/settings.json`** writes the card at
the end of every session, in every environment, whether or not anyone reached
`prep-pr`. It is idempotent — it rewrites the same file — it already refuses
`main`, and it ends in `|| true` so it can never fail a session. The settings
file is committed, so remote sessions pick it up with no per-machine setup.

The consequence to remember: **a remote card can never be refreshed past
`at-open`**, because the container that held its transcripts is gone. That is
why the `merged` view filters on merge status rather than on `phase` — see the
warning below.

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
| `interaction.tokens_before_first_edit` | Exploration cost, summed per session. **`null` when no edit was observed** — see below |
| `interaction.sessions_with_observed_edit` | How many sessions contributed to that figure, so a partial reading reads as partial |
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
- `at-merge` — written after merge, includes review fixes.

> [!caution] Do not filter a query on `phase = 'at-merge'`.
> It looks like caution and behaves like bias. A remote session's cards stay
> `at-open` forever, so that filter silently drops every pull request not worked
> on a machine you still own — and every trend then describes your laptop rather
> than the fleet. Both `merged` views (SQL and `report`) filter on **merge
> status**, and keep `phase` as a visible column instead. Query 7 reports the
> split so an `at-open`-heavy corpus is obvious rather than invisible.

> [!warning] The `at-merge` refresh cannot run in CI, and this is not a gap
> that can be closed.
> `~/.claude/projects` is local and unversioned. A GitHub Actions runner has no
> transcripts, so a workflow can update `merged_at` and the final diff but not
> a single token of spend — and a card that silently kept `at-open` spend under
> an `at-merge` label would be worse than no card at all, because no query
> could tell it from a complete one.
>
> The refresh is therefore a **local** command, run on the machine that did the
> work:
>
> ```bash
> bun run --cwd tools/pr-metrics card -- \
>   --branch feat/x --phase at-merge --merged-at "$(date -u +%FT%TZ)"
> ```
>
> In practice the backfill below is the easier path: it rewrites every merged
> pull request it has transcripts for in one pass, so the `at-merge` set can be
> brought up to date periodically instead of per-merge.

## Backfilling

`bun run --cwd tools/pr-metrics backfill` writes cards for pull requests that
merged before cards existed.

```bash
bun run --cwd tools/pr-metrics backfill -- --dry-run     # list what it would write
bun run --cwd tools/pr-metrics backfill -- --limit 200
```

A merged branch is usually deleted, so the file list comes from the GitHub API
(`repos/:owner/:repo/pulls/:n/files`) rather than a local `git diff`. Spend
still comes from local transcripts, so a backfill reaches only as far back as
this machine's logs and only for branches this machine worked on.

**A pull request with no local transcript is skipped, not written as zero.** A
zero-cost card is indistinguishable from a genuinely cheap one once it is in
the datalake, and it would drag every average it touches toward nothing.

Ratings are transcribed, never invented: a backfilled card carries whatever the
issue's `complexity:` label says, and `rate-complexity`'s backfill mode marks
anything it adds `complexity:unconfirmed`.

## The two fields that name a cause

Most of the card describes cost. Two fields point at what to *do*, one per
lever:

**`tokens_before_first_edit` → a missing skill or wiki page.** Everything spent
before the first edit is the agent working out where the code lives. It is
summed per session, so a second session re-orienting from scratch is charged
again rather than hidden behind the first session's answer. Repeatedly high in
one area means that area has no usable map.

> [!warning] An edit is not only an `Edit` call, and an unseen edit is `null`.
> This repository's agent instructions tell agents to change files "with sed,
> heredocs, or short scripts, rather than using the dedicated Edit tool", so
> counting only `Edit`/`Write` missed most of them. In the first 34 cards, 15
> pull requests changed real source with zero `Edit` calls, and each reported
> that **100%** of its tokens went on exploration. The per-package ranking was
> then sorted by which branches happened to avoid the Edit tool: `cire/host`
> appeared worst in the repository at 62%, and reads 5% once fixed.
>
> Two rules follow. Shell writes count as edits (`sed -i`, heredoc redirects,
> `tee`, `mv`) — conservatively, since a false positive moves the boundary too
> early. And a session that never shows an edit banks **nothing**: the card
> reports `null`, and every ranking drops it. "We did not see the boundary" and
> "all of it was exploration" are different claims, and only one is true.

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

**`bun run --cwd tools/pr-metrics report` is the normal way in.** It computes
the seven analyses over the same cards, in TypeScript, and needs nothing
installed:

```bash
bun run --cwd tools/pr-metrics report               # all seven
bun run --cwd tools/pr-metrics report -- --waste    # just one
```

That matters because **DuckDB does not exist in a remote session.** None of the
`duckdb` npm packages ship a binary — they are all libraries — so `bunx` is no
help and there is no `brew` in a cloud container. A report that only runs on one
laptop cannot tell you how the fleet is doing.

`queries.sql` is the same seven in SQL, and it is the better tool for a question
nobody anticipated. It is the optional local power tool, not the interface:

```bash
duckdb -init tools/pr-metrics/queries.sql     # local only; brew install duckdb
```

The two carry the same ratio definitions, duplicated on purpose. Change one,
change the other.

It defines `cards` (everything), `merged` (`at-merge` only) and `metrics` (the
shared ratios), then answers: where agents cost too much for the job; which
packages need a skill or a wiki page; whether briefs are getting clearer;
whether the context surface is bloating; cost per unit of declared difficulty;
whether delegation is paying off; and — run this one first — how much of the
history can be trusted at all.

Every per-pull-request distribution is summarised with a **median, never a
mean**. These are severely right-skewed: across the first 34 cards the median
was 3.6M tokens, the mean 15.4M and the maximum 92.7M. The mean described the
three largest pull requests and showed 8.5× month-over-month growth where the
median showed about 2×.

The raw view, if you want to start from nothing:

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
