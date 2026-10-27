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
  - "[[shared/observability/overview]]"
  - "[[shared/observability/metrics]]"
  - "[[conventions/review-findings]]"
  - "[[conventions/stacked-prs]]"
last-reviewed: 2026-10-28
---

# Session Metrics

Every pull request gets a **card**: a JSON record of what the agent session that
produced it cost, what it changed, and how much steering it needed. Cards live
at `.claude/metrics/<branch-slug>.json`, one file per branch, committed in the
pull request they describe. A branch name an earlier pull request already used
gives the later one `<branch-slug>-<pr>.json` — see
[[#One card per pull request]].

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
**before work starts** — the `write-issue` skill does it when the issue is filed, through the
`rate-complexity` skill (`.claude/skills/rate-complexity/SKILL.md`), which proposes a number from the issue body alone and
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
A card whose pull request closes several issues declares the sum of their
ratings, which can be any whole number — see [[#Which issue a card names, and what it divides by]].

Exclude unconfirmed ratings from anything you intend to act on — they are an
agent's guess standing alone, and mostly arrive from the backfill of issues that
predate the label.

## Which issue a card names, and what it divides by

Two answers, kept apart. `issue.number` is the issue the branch was cut for.
`complexity.declared` is the sum of the ratings of every issue in this
repository the pull request closes, or, when it links no issue here, of the
private tracker issues it closes. A branch that closes three issues did three
issues' work, so dividing its spend by one of their ratings makes it read three
times as dear as it was. `card -- --resolve-issue` and `backfill` share the
functions that decide both (`selectIssues`, `issuesToRate` and
`decideComplexity` in `tools/pr-metrics/index.ts`).

**The issue** — the first of these that applies:

1. `--issue <n>`. With `--resolve-issue` it names the issue and nothing else:
   the sum below still runs, and no label is read for a number the pull request
   does not close. It takes this repository's issue only, never a tracker
   number: with `--resolve-issue`, the number of another repository's issue the
   pull request links is refused, and the card names none.
2. `NEW-FEAT.md` at the root of the checkout, when it chooses among the pull
   request's own links. The file is untracked scratch and survives a branch
   switch, so it counts only when the checkout has the carded branch out and
   the branch name appears, as a whole word, in its first 30 lines. The issue is
   the first reference on its first `Issue:` or `Issues:` line (a `| Issue |`
   table row counts too), and a Markdown link counts by its target, not its
   text. A tracker reference there names nothing. It never
   adds an issue the pull request does not link, and it is not read before a
   pull request exists.
3. The first `Closes`, `Fixes` or `Resolves #N` line of the body, in body order.
4. The first `Part of #N` line.
5. The one issue in this repository GitHub lists in `closingIssuesReferences`.

Otherwise the card names no issue, and when GitHub lists several it warns and
names them. It never takes a position in GitHub's list: GitHub orders it by
issue number, not by what the branch was cut for, and taking the first put a
$49.77 session against a complexity-1 follow-up the same pull request closed
(#1566).

The body is read as prose. A closing keyword in a code span, a fenced block, an
HTML comment or a table row is not read, because GitHub does not act on it.

**What the pull request closes** — in this repository and in others alike: for
an open pull request, its body's `Closes` lines and GitHub's references
together, each issue once: a stacked pull request has no references until
GitHub retargets it to `main`. For a merged one (`backfill`), GitHub's
references alone, since they are what the merge closed.

**The denominator** — the first of these that applies:

| Case | `declared` | `method` | `issues` |
|---|---|---|---|
| Closes issues here, every one rated | The sum | `confirmed`, or `unconfirmed` if any part is | How many were summed |
| Closes issues here, one has no rating | null | `none`, with a warning naming it | 0 |
| Closes issues here, a label lookup failed | null | `lookup-failed` | 0 |
| Closes nothing here, has a `Part of` line | null | `part-of` | 0 |
| Links nothing here, closes tracker issues, every one read and rated | Their sum | `confirmed`, or `unconfirmed` if any part is | How many were summed |
| Links nothing here, closes a tracker issue this run could not read | null | `not-fetched`, with a warning that counts it | 0 |
| Links nothing here, closes tracker issues, one has no rating | null | `none`, with a warning that counts it | 0 |
| Links nothing here, only `Part of` another repository's issue | null | `part-of` | 0 |
| Links nothing here, closes an issue in a third repository, or one GitHub did not register | null | `not-fetched` | 0 |
| Links nothing | null | `none` | 0 |

**From a tracker issue, a card takes only its `complexity:N` and
`complexity:unconfirmed` labels.** Its `severity:` and `area:` labels must never
reach a card committed to this public repository (`AGENTS.md` §Issues), so
every answer from the tracker passes through `ratingLabels` as it arrives, and
`issue.labels` is read only from an issue in this repository: a card that rates
tracker work names no issue and has `issue.labels: []`. Only
`englishstreetventures/osn-tracker` is ever asked, at most 50 issues per run;
anything past that, or a token that cannot read the tracker, records
`not-fetched`. The rating needs a token that can read the tracker wherever
`card` or `backfill` runs. `--resolve-issue` reads the newest pull request
whose branch lives in this repository: `gh pr list --head` matches the branch
name in every fork too, and a fork's body never decides which tracker issues
are asked about. A warning names an issue here by number and counts tracker
issues without naming them, because warnings end up in public test plans.

`--issue-labels` and `--complexity` supply the rating themselves and turn the
lookup off; a rating read from `--issue-labels` counts one issue, and a
`--complexity` one counts none.

Five things this does to the comparison of spend against declared difficulty:

- **A sum is not a Fibonacci number.** Queries 5 and 6 group by `declared`, so a
  batched branch's 6 or 11 forms a row of its own: points of declared work, not
  a rating anyone gave.
- **Overlapping issues inflate the sum.** Three issues that describe one defect
  from three sides add up to three issues' worth. `complexity.issues` shows how
  many were summed, so a reader can tell 6 from three issues from 6 from one.
- **Beside an issue here, a tracker issue adds nothing.** Those tracker issues
  are mostly the branch's own review findings, which `prep-pr` files and the
  branch fixes, so the issue here states the work; their ratings would make a
  branch whose review found more read cheaper per point. No tracker issue is
  asked about for such a pull request.
- **A tracker-only sum counts the review's findings too.** With no issue here,
  every tracker issue the pull request closes is summed, the finding the branch
  was cut for and those its review filed alike, so the sum runs high.
- **A `Part of` pull request is unrated.** The issue's rating describes the
  whole of it, and the branch did a part. A series of stacked pull requests
  records `part-of` on each but the one that closes the issue, which carries the
  whole rating against its own spend.

Cards with a `schema_version` below 3 predate the sum: their `declared` is one issue's
rating, taken from the first issue GitHub listed or from the body's one link.
Cards below 4 never read a tracker issue: one that closes only tracker issues
records `not-fetched`.

*Measured 2026-10-27 over the last 100 merged pull requests (`gh pr list --json
closingIssuesReferences`, then each tracker issue's `createdAt` against the pull
request's first commit): 28 closed an issue here and 121 tracker issues besides,
103 of them filed after the branch's first commit; 11 closed only tracker
issues, 39 in all, 32 filed after it.*

## Who writes a card

Three writers, and only one of them is the owner.

| Writer | When | Carries identity? |
|---|---|---|
| The **`retro`** skill | Once, straight after `prep-pr` opens the pull request | Yes — `--resolve-issue` finds the pull request, names its issue and sums the ratings of what it closes; `--pr`, `--issue` and `--issue-labels` override it. It commits the JSON and appends the `<details>` block to the pull-request body |
| The `SessionEnd` hook | At the end of every session, in every environment | Only what `--resolve-issue` finds, which is nothing before the pull request exists. It runs `card -- --if-absent --resolve-issue`, so it writes a card for a branch that has none and never touches one `retro` committed |
| `backfill` | Retrospectively, over merged pull requests | From the GitHub API — see [[#Backfilling]] |

`retro` runs after the pull request is open, so the card covers the whole
session — on any diff that is not docs and tests alone, `prep-pr`
dispatches `review-tests`, `review-performance` and `review-security`, and a
card written before those finish measures building the change rather than
shipping it.

> [!warning] The fallback must never overwrite the owner's card.
> The hook has no way to know the pull request, the issue or the rating — it
> runs unattended as a session closes. Left unguarded it rewrites `retro`'s
> card with one whose `pr.number`, `issue.number` and `complexity.declared` are
> all null, into a working tree nobody is watching, and the result then sits in
> the corpus looking complete while answering none of the questions the cards
> exist for. `--if-absent` is what stops that: it checks for the file and exits
> before it reads a single transcript.

### One card per pull request

A card names one pull request, and neither `card` nor `backfill` ever writes
over a card that names another.

**A reused branch name.** Transcripts are joined to a card by branch name alone,
so two pull requests on one name share every record. The merges separate them:
the first pull request on the name keeps `<branch-slug>.json` and takes the
records up to its merge; each later one writes `<branch-slug>-<pr>.json` and
takes the records after the merge before it. An open pull request counts as
after every merge. A session that runs across a merge is cut at it, so each
side's interaction figures for that session come from part of it.
`chore-cire-migration-baseline.json` (#984) and
`chore-cire-migration-baseline-1375.json` (#1375) are the pair that made this
rule.

| Case | `card` | `backfill` |
|---|---|---|
| The file at the slug path names another pull request on the same branch name | Writes `<branch-slug>-<pr>.json` from the records after that pull request's merge | Same, oldest merge first; cards already on disk count as well as the listing, so one older than `--limit` still holds its file |
| The earlier pull request's merge time is unknown — its card has no `merged_at` | Asks `gh` with `--resolve-issue`; refuses without it, or when `gh` cannot answer | Skips the pull request and says why |
| The earlier pull request closed without merging | Refuses: no merge separates the two. If both are one piece of work, delete the earlier card and run again | Not listed: `backfill` reads merged pull requests only |
| A pull request's window holds no records — its transcripts are gone | Writes the card with zero spend, as on any branch with no transcript | Skips it, so a measured card is never replaced by a zero one |
| The file names another pull request on another branch name — `feat/a-b` and `feat-a-b` flatten to one file — or this run names no pull request | Refuses | Keeps the first and skips the second |

A refusal prints both numbers on stderr, writes nothing, renders no
`--format markdown` block, and exits 1. A card whose `pr.number` is null is the
fallback's identity-less one, and `retro` replaces it.

`new-feat` Step 1 and `orchestrate` Step 2 still check a name is unused before
cutting it — no card for it on `origin/main`, and no pull request with that head
branch — because the split is only as good as the merge times: a session that
does the earlier pull request's follow-up work after its merge lands on the
later card.

## Where the data comes from

Claude Code writes a transcript per session under
`~/.claude/projects/<encoded-cwd>/`, and stamps `gitBranch` on every assistant
message. For a session that runs in its own task worktree that field is the
join: this repository runs one worktree and one branch per task, so a branch
name maps to one pull request as long as no name is used twice — see
[[#One card per pull request]]. For delegated work it is not enough — see
[[#Attributing subagent spend]].

Seven traps the collector handles and any reimplementation must:

- **Subagent spend is in a sibling directory**, `<session-id>/subagents/*.jsonl`,
  not in the main transcript, and a Workflow run's agents write one level
  deeper, `subagents/workflows/<run-id>/agent-*.jsonl`. Missing it under-reports
  every delegated task, and on orchestrated work that is most of the cost.
- **One conversation is sometimes written into two session files.** 615 assistant
  records on this machine — 5.2% of session spend — appear in both, and reading
  them twice doubles the branch's cost. A duplicate repeats the record's `uuid`,
  so that is what `readRecordsForBranch` keys on, returning each once.
- **One API response is several records.** A thinking block, a text block and one
  per `tool_use` all reach the transcript separately, sharing a `requestId` and
  repeating that response's `message.usage` verbatim. The two phenomena pull
  opposite ways and must not share a key: keying the record dedupe on `requestId`
  keeps the first block of every response and throws the rest away, which is
  every tool call the response made bar one. So records dedupe on `uuid`, and
  every reader of `message.usage` — `aggregateSpend`, and the exploration sum in
  `aggregateInteraction` — counts a `requestId` once instead, or a response's
  cost is multiplied by the number of blocks it was split across.
- **Most `role: "user"` records are machinery** — tool results, hook output,
  system reminders, slash-command envelopes. Counting them destroys `user_turns`
  as a measure of steering.
- **A prompt typed while the agent is working is not a `user` record at all.**
  It arrives as `type: "attachment"` with `attachment.type === "queued_command"`
  and the text under `attachment.prompt`. This shape is the whole of
  `corrective_turns`: a queued prompt is one the person sent mid-turn, and a
  `user` record is one sent to an idle agent. A queued prompt is sometimes
  echoed back as a `user` record once dequeued, so a `user` record that is the
  next human record in its session after a queued prompt with the same text is
  collapsed into it. Two identical `user` turns never are, because a person who
  types "continue" twice steered twice.
- **Not everything in that shape is a prompt.** Subagent hand-backs,
  background task notifications and the harness's own notices are delivered as
  queued commands too. The harness labels the sender in
  `attachment.origin.kind`, and the collector reads that as an allow-list: only
  `human`, or a record marked `humanTurn: true`, is a person. `task-notification`,
  `peer` and `coordinator` are not, and a kind it has never seen counts as no
  turn — the CLI warns and names it, so a new sender cannot zero the field
  unnoticed. A transcript older than the label falls back on
  `attachment.commandMode`, where only `prompt` is typed text. Either way the
  prompt must also pass the tag test the `user` branch applies: no leading `<`,
  which rejects `<agent-message …>` and `<task-notification>`.
- **Not every session in the directory is the person's.** `~/.claude/projects`
  keys transcripts by working directory, so a headless tool run against a
  worktree writes into the same directory as the person working there, and its
  opening instruction is an ordinary `user` record with no tag to reject it by.
  `entrypoint` separates them: `cli` is a terminal, `sdk-py` and `sdk-cli` are
  programs. Absent means a transcript older than the field, and an absent value
  keeps the previous answer rather than guessing.

*Measured 2026-09-08 — a one-off scan of `~/.claude/projects/**/*.jsonl` on the
machine that did the work. No script was kept, and that directory is local and
unversioned, so the counts describe one machine on one day and nobody else can
reproduce them. They size the traps; they are not a repository statistic.*

## Attributing subagent spend

A **subagent's** `gitBranch` is fixed to whatever its parent's was at the
moment of dispatch and never re-derived afterward. A subagent working in a
task worktree therefore records the branch its *parent* started on, and
`isolation: "worktree"` does not help — it pins the subagent's `cwd` and still
reports the parent's `gitBranch`. (A top-level session's own `gitBranch`, by
contrast, is recomputed per record from its live `cwd` — the gap this causes
is narrower: a session that plans and dispatches without ever `cd`-ing itself
stays stamped `main` throughout for that reason alone. See "Attributing
main-thread spend" below.)

The scale, measured over 904 transcript files and 9.03e9 tokens:

| Where the spend sits | Share |
|---|---|
| Stamped `HEAD` (the bare-repo root) | 62.4% |
| Stamped `main` | 12.1% |
| A real branch | 25.5% |

Subagent transcripts are 27.0% of all spend, and **85.8% of that is stamped
`HEAD`** against 7.4% on a real branch. A branch whose work was delegated saw
almost none of its own cost.

*Measured 2026-09-08 — the same one-off scan of `~/.claude/projects` as above,
904 transcript files, and the depth-2 counts below come from it too. One
machine, one day, no script kept.*

So `orchestrate`, `stress-plan`, `prep-pr`, `review-pr` and `new-feat`'s
`Plan`-subagent dispatch each put a marker on its own line at the top of every
dispatch prompt, and a Workflow script puts one at the top of the task it
computes for each agent it starts:

```
TASK-BRANCH: feat/example
```

`resolveDispatchBranch` in `tools/pr-metrics/index.ts` reads it back. Every
subagent an `Agent` call starts has a sibling `agent-<id>.meta.json` carrying
the `toolUseId` of that call; that id appears on the `tool_use` block in the
parent transcript, whose `input.prompt` is the dispatch. The marked branch then
replaces `gitBranch` for every record in that file.

Six things about it worth keeping:

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
- **A Workflow run's agents are read from their own transcript.** A script
  starts them, not an `Agent` call, so they sit under
  `subagents/workflows/<run-id>/`, their sidecar carries no `toolUseId`, and no
  parent transcript holds their prompt. The harness opens each one's transcript
  with two `user` records: its relay of the user request that started the run,
  then the task the script computed for this agent. Each has a header line of
  the harness's own, and every line the harness relays below it is indented by
  two spaces. The collector reads the marker from the task record alone — the
  one whose first line starts `[Workflow harness — computed task]` — within its
  first three lines, and allows the indentation there and nowhere else. It never
  reads the relay, which is the same text for every agent of a run that may
  drive several branches, nor anything after the agent's first reply. The run's
  `journal.jsonl` is a log, not a transcript, and is not read.

  *Measured 2026-10-27 — `jq` over the `user` records before the first
  `assistant` record of every `subagents/workflows/*/agent-*.jsonl` on one
  machine: 98 agents in 5 runs, each opening with one relay record and then one
  task record.*

This is **not purely forward-looking**. `resolveDispatchBranch` also falls back
to `resolveSessionBranch` (below) when a dispatch's own parent is the
top-level session file and carries no marker — the ordinary shape for a
transcript recorded before this fix existed. A `backfill` run rewrites every
historical card whose cutting session is still on the machine that ran it;
that is intended, not a side effect. What stays genuinely unrecovered is a
session that cut more than one branch (an `orchestrate` run driving several
tasks) — `resolveSessionBranch` returns `null` there on purpose, rather than
guessing which task an unmarked dispatch belonged to.

A wholly delegated card reports zero `user_turns` and "not observed" for first
edit by construction — those skip sidechain records.

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
`retro`. It runs `card -- --if-absent`, so it only ever fills a gap — see
[[#Who writes a card]]. It is otherwise idempotent — it writes the same file,
and leaves it untouched when the only field that would change is `generated_at`
— it already refuses `main`, and it ends in `|| true` so it can never fail a
session. The settings file is committed, so remote sessions pick it up with no
per-machine setup.

The consequence to remember: **a remote card can never be refreshed past
`at-open`**, because the container that held its transcripts is gone. That is
why the `merged` view filters on merge status rather than on `phase` — see the
warning below.

## Attributing main-thread spend

A session that plans and dispatches without ever `cd`-ing itself — the
ordinary `new-feat`/`stress-plan`/`prep-pr` shape, run directly rather than
through `orchestrate` — never shows a worktree `cwd` on its own records
either, so `record.cwd` carries no signal to match against `git worktree
list`. What it does contain is the command that cut the worktree in the first
place: `git worktree add <dir> -b <branch> …` (local) or `git checkout -B
<branch>` (remote), the same two commands `new-feat` Step 1 runs.

`resolveSessionBranch` in `tools/pr-metrics/index.ts` scans a session file's
own `Bash` tool calls for that shape and resolves to the single branch it
cut — or `null` when it cut none, or more than one (the `orchestrate` case,
several tasks in one sitting). `readRecordsForBranch` and `recordsByBranch`
use it as a fallback: a record whose own `gitBranch` is absent, `"main"` or
`"HEAD"` is attributed to that resolved branch, and a record that already
carries a real, different branch is never overridden.

Two things worth keeping in mind:

- **The window is the whole file, not just the records after the cut.**
  Bounding it to "after the worktree-add command's timestamp" would exclude
  Step 0's own issue-taking and complexity-rating spend, which legitimately
  belongs to the task and happens first. So a `main/` session that also does
  clearly unrelated work in the same sitting as cutting one branch — answering
  an unrelated question, running `/analyse-sessions` — has that unrelated work
  counted too. Same per-file granularity `resolveDispatchBranch` already uses
  for subagent files, not a new kind of imprecision.
- **An `orchestrate` session driving exactly one task is attributed to it.**
  That is correct, not an accident: the guard that matters is the multi-branch
  case (`null` on ambiguity), and at one task there is nothing to split
  unfairly. What stays deliberately uncarded is `orchestrate` at N>1 — there
  is no principled way to divide one session's overhead across several task
  branches, so it is not attributed to any of them.
- **A session that made a worktree and moved into it is attributed to it.** A
  session started in `main/` or the bare-repo root that makes a worktree with
  the `EnterWorktree` tool runs no `git worktree add`, so the scan above finds
  nothing — and its records before the move, the request and the work that led
  to the branch, are stamped `HEAD` or `main`. Claude Code writes a
  `worktree-state` record naming the branch, and only when the move succeeds;
  `resolveSessionBranch` takes that branch when the session cut none with git,
  by the same one-branch rule. A branch cut with git outranks one made this
  way. Records after an `ExitWorktree` back on `HEAD` or `main` go to that
  branch too, as does an unmarked subagent the session dispatched (through
  `resolveDispatchBranch`'s fallback) — the same per-file granularity as above.
- **A worktree the session only entered counts for nothing.** `EnterWorktree`
  given the path of a worktree that already exists writes a `worktree-state`
  record with `enteredExisting: true`. That worktree was cut for other work —
  the session is reviewing it, or an orchestrator is checking on a task — and
  what the session did before the move has nothing to do with it. Only the
  records stamped with that branch go to its card.

  *Measured 2026-10-23 over both transcript roots on the machine that did the
  work: 11 session files hold a `worktree-state` record naming a branch, 3 for
  worktrees the session made and 8 for worktrees it only entered. One of the 3
  made six worktrees, so it resolves to none. Against the rule without either
  bullet, 2 branches gained spend and none lost; counting entered worktrees as
  well would have moved spend onto 6 more. One-off comparison of
  `recordsByBranch` before and after; no script was kept.*
- **Only records that belong to a session.** Claude Code also writes
  bookkeeping into a session file — file-history records among them — with a
  timestamp but no session id and no branch. The fallback leaves them out:
  claimed, each counted as a session of its own on the card.
- **Assumes `main/`'s own checkout stays on `main`** (the owner's global `~/.claude/CLAUDE.md`: never
  check out a feature branch inside an existing worktree). When violated, a
  session's records already carry that other branch's real name and fall
  outside `isAmbiguousBranch`'s trigger entirely — not reattributed by this
  fallback, but not made worse by it either; they were already going to
  whichever branch `main/` happened to be on.

## Schema

`schema_version` is `4`. Bump it when a field changes meaning or leaves. Version
4 made `interaction.corrective_turns` count only the prompts sent while the
agent was working; on an older card it counted every human turn after the
session's first tool call, and every reader treats that count as unknown — see
[[#The two fields that name a cause]]. Version 4 also rates a pull request that
links no issue here from the tracker issues it closes; an older card records
`not-fetched` for it. Version 3 made `complexity.declared` a sum over the issues
a pull request closes and added `complexity.issues`; on an older card `declared`
is one issue's rating.

| Field | Meaning |
|---|---|
| `pr.number`, `pr.branch`, `pr.base_sha`, `pr.head_sha` | Identity |
| `pr.phase` | `at-open` or `at-merge` — see [[#Two phases]] |
| `issue.number`, `issue.type`, `issue.labels` | The issue the branch was cut for — see [[#Which issue a card names, and what it divides by]]. Only ever an issue in this repository, and `labels` only ever its labels: never a tracker issue's, whose number is not recorded and whose labels other than the `complexity:` pair are never kept. With `--resolve-issue`, `labels` are read only when that issue is one the pull request closes |
| `complexity.declared` | The sum of the ratings of the issues in this repository the pull request closes or, when it links none here, of the tracker issues it closes — 1, 2, 3, 5 or 8 for one issue. On a tracker-only card, `declared` and `issues` show how many tracker issues it closed and their summed rating; the pull request's own `Closes` lines already show the count. The only judgement in the file |
| `complexity.method` | How that number was arrived at: `confirmed`, `unconfirmed`, `none`, `not-fetched`, `lookup-failed`, `part-of`, or `manual` for `--complexity` |
| `complexity.issues` | How many issues' ratings `declared` adds up. Absent before version 3 |
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
| `interaction.corrective_turns` | Prompts the person sent while the agent was still working — interruptions. A turn sent after the agent stopped (a new task, an answer to its question, "continue") is not counted. Before version 4 it counted every human turn after the first tool call; readers show that as unknown |
| `interaction.tokens_before_first_edit` | Exploration cost, summed per session. **`null` when no edit was observed** — see below |
| `interaction.sessions_with_observed_edit` | How many sessions contributed to that figure, so a partial reading reads as partial |
| `interaction.edit_churn` | `files_edited_3plus`, `max_edits_one_file` |
| `interaction.skills`, `interaction.subagents`, `interaction.tool_calls` | Histograms |
| `interaction.requests` | Model calls: `main`, `subagent`, `with_tools`, `with_one_tool`, and the nearest-rank `context_median` and `context_p90` of input plus cache read plus cache write per call. Absent on older cards |
| `review` | Whether review findings led to a change — see [[#Review findings acted on]]. `null` when no report was read; absent on older cards |

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

- `at-open` — written by `retro`, covers work up to the pull request.
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

## Model calls

Cache reads are most of what a session costs, and each call re-reads the
whole context, so cost is roughly calls times context. `interaction.requests`
records both. A response split over several records sharing a `requestId` is
one call; the harness's `<synthetic>` records are none. `with_one_tool`
against `with_tools` says how often a call ran one tool when it could have run
several in parallel.

## Review findings acted on

`card` reads the review reports at the checkout root (`TEST-REVIEW.md` and
`DOCS-REVIEW.md`, or the files `--review-reports` names) and asks of each
finding: did a commit after the review act on it? The security and performance
reports are not opened: they hold only tracker kinds.

A finding is acted on when a line within 3 of the one it cites changed after
the review. A tests finding is also acted on when its fix is a new test rather
than a change at the cited line: a commit after the review added lines to a
file under the same package's `tests/`, and that file imports the cited file.

- **The package** is the nearest directory above the cited file that holds a
  `package.json` or a `tests/` directory at the branch's head, or the
  repository root where none does. `scripts/` counts through its `tests/`.
- **Imports** means a relative specifier that resolves to the cited file:
  `from`, a bare or dynamic `import`, `require`, `importActual`, a mock
  (`vi.mock`, `doMock`, `mock.module`) or `new URL(…, import.meta.url)`. A code
  extension and a trailing `/index` are ignored on both sides. A path in a
  plain string is not an import.
- **Added lines** is the net diff from the reviewed commit to the head: lines
  added and then removed again do not count, and a test file that only lost
  lines does not count.

| Field | Meaning |
|---|---|
| `reports` | Reports read |
| `findings` | `T-` and `D-` findings in them |
| `located` | Those whose **Issue** line names a `path:line` inside a file that existed when the review ran |
| `acted_on` | Located findings acted on, by either rule above |
| `paired` | Located findings with room for a control line 35 lines away in the same file |
| `acted_on_paired`, `control_changed` | Of the paired, how many were acted on, and how many control lines changed |
| `acted_on_by_test`, `acted_on_paired_by_test` | Of `acted_on` and `acted_on_paired`, the tests findings whose cited lines did not change and that count only because a test landed |

The control has no test half: it asks only whether a line changed. Read
`acted_on_paired - acted_on_paired_by_test` (the report's **by line**) against
`control_changed`, never `acted_on_paired` alone. `control_changed / paired` is
the rate at which lines change anyway.

> [!important] Only tests and docs findings are counted.
> The card is public. `S-`, `P-` and `C-` findings live in the private tracker,
> and a count of those left unchanged would describe an unpatched defect in
> public. The card holds counts only — no ID, lens, severity or path.

How the reviewed commit is found: the newest commit on this branch (first
parent, after the merge base) whose **author** time is no later than the
report's mtime. Author time survives a rebase; committer time does not. A
report older than every commit on the branch, or left by another branch, is
not read. Nor is one whose reviewed commit is the newest and was committed
after the report: a fix was amended or squashed into it, and nothing is left to
diff.

What the figure cannot say:

- **It is a snapshot.** The reports are gitignored scratch and go with the
  worktree, so the first run that reads them is the record. A later run keeps
  it unless it passes `--review-reports`, and `backfill` copies it. The
  `SessionEnd` fallback (`--if-absent`) never reads them: it can fire between
  the reviews and the fixes, and a figure taken then would be kept.
- **It measures what changed, not how good a finding was.** `prep-pr` fixes
  every in-scope finding, so a weak finding is changed as surely as a strong
  one. A finding moved to a follow-up pull request reads as not acted on.
- **A `review` block without `acted_on_by_test` counts every finding by its
  cited line alone.** The collector that wrote it did not count a landed test.
  Which collector a branch runs depends on when the branch was cut, not when it
  merged, and a later run keeps the block it finds, so neither the card's date
  nor its `schema_version` says which rule a block used; the field does.
- **The test rule reads high.** Any lines added to a test file that imports the
  cited file count, whatever they test. A type-only import counts, and so does
  an import written inside a string, as lint-rule tests hold. In a package
  whose tests all import one module (`tools/pr-metrics` and its `index.ts`), a
  tests finding on that module counts once any test there changes.
- **The test rule misses some real fixes.** It never matches an import by
  package name, a test that imports a barrel (`../src`) rather than the cited
  file, a CLI test that names its script with `join(…)` or a plain path, or an
  E2E flow under `tools/e2e`, which is another package and drives the running
  stack rather than importing anything. A test file moved after the review
  counts as added.
- **Most findings are unlocated.** `review-tests` names a file and an export,
  not a line, so `located` is mostly docs findings, and most tests findings are
  counted by neither rule.

## Comparing before and after a change

```bash
bun run --cwd tools/pr-metrics report -- --split-at <commit>
```

Splits the cards by whether all their sessions ran before the commit landed
(its committer time) or all after, and compares cost per declared point
(confirmed ratings only), model calls, cache-write share and the review rates.
A card with sessions on both sides is excluded and counted. By time, not
ancestry: most cards carry a `base_sha` no local clone still holds. Change one
thing at a time, so the split names one change.

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
the datalake, and it would drag every average it touches toward nothing. The
same holds on a reused branch name for a pull request whose window between the
merges holds no records; see [[#One card per pull request]] for how `backfill`
splits a name two pull requests share.

Ratings are transcribed, never invented: a backfilled card carries whatever the
issue's `complexity:` label says, and `rate-complexity`'s backfill mode marks
anything it adds `complexity:unconfirmed`.

The issue and the rating follow [[#Which issue a card names, and what it divides by]],
with two differences: there is no `NEW-FEAT.md` to read, and a merged pull
request is credited with the issues GitHub registered as closed. Labels are
fetched by GraphQL node id in one batched `nodes(ids:)` call, so an issue named
only in the body is recorded with no labels.

**A card's labels come only from this repository's issues; a tracker issue
gives only its rating.** A pull request that links no issue here is rated from
the tracker issues GitHub registered as closed. Their node ids go in a
`nodes(ids:)` call of their own, so a tracker this token cannot read never
costs a public lookup, and the answer keeps only each issue's `complexity:`
pair. The card names no issue and writes `issue.labels: []`: a tracker
issue's number and its `severity:`/`area:` labels must not reach a card
committed here (see `AGENTS.md` §Issues on not linking a finding from a public
file). A tracker issue the token cannot read writes
`complexity.method: "not-fetched"`, not `"none"`: a rating may well exist
there, unread. So does a body that names a tracker issue GitHub did not
register as closed: GitHub may leave out a reference to a repository the token
cannot see.

"Same repository" is decided against the canonical name: `backfill` asks
`gh repo view <--repo>` once, and `gh` follows a renamed owner and answers in
GitHub's own case. A `--repo xchromo/osn` or `EnglishStreetVentures/osn` still
reads this repository's issues. Where `gh` cannot answer, the typed name stands
in, compared ignoring case.

**A backfill never lowers a rating on disk.** When the card already written for
the same pull request holds a rating and this run's has none, or holds a
`confirmed` one and this run's is not, it keeps the card's `complexity` and says
so on stderr. A failed lookup, or an issue this run cannot read, must not erase
the only record of the rating. The card's `issue` comes with it only when
this run links that issue to this repository: a card is public, and an issue
block written some other way may name a tracker issue or carry its labels.
Two cases are not a lowered rating, or cannot carry one:

- **This run records `part-of`.** That null is the rule's answer, not a failed
  read. A rating looked up from the issue (`confirmed`, `unconfirmed`) is
  dropped, since it describes the whole issue; one given by hand is kept.
- **The card on disk rates fewer issues than the sum now covers.** A
  card before version 3 rates one issue, and version 3's `declared` is the sum over
  all of them: carried across, one issue's rating would count four issues of
  work as one. A new sum is written instead. When this run has no sum either,
  the card on disk is left as it is, on its old version, and the run names it —
  unless that card's `issue` names an issue this run does not link here, or
  carries labels with no issue. Then the rebuilt card is written, without the
  old rating, so no tracker number or label survives.

Only `"confirmed"` is a rating to act on; every other method is either an
agent's guess (`"unconfirmed"`) or a null `complexity.declared`, for the reasons
in the table above.

## The two fields that name a cause

Most of the card describes cost. Two fields point at what to *do*, one per
lever:

**`tokens_before_first_edit`: a missing skill or wiki page.** Everything spent
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
>
> *Measured 2026-09-07 over the 34 cards that existed then. Re-derive the
> per-package share over today's corpus with
> `bun run --cwd tools/pr-metrics report -- --exploration`.*

**`corrective_turns`: where the brief fell short, once you read the
prompts.** The prompts the person sent while the agent was still working —
interruptions. A turn sent after the agent stopped and handed back (a new task,
an answer to its question, "continue") is not counted, however late in the
session it comes, so a long session that took on new work turn by turn does not
read as a badly briefed one. High means the person had to step in mid-run.

Two limits keep it from being a verdict on its own:

- **An interruption is not always a correction.** Some are status notes
  ("Merged a bunch of PRs") or added scope. Read the prompts; the corrections
  among them are the brief's gaps.
- **An orchestrator's redirects are mostly not counted.** While a session waits
  on background subagents its main agent is idle, so a redirect sent then lands
  as an idle turn. A low count on an orchestrated branch says less than it
  seems.

> [!warning] A card before version 4 counted something else
> Before `schema_version` 4 the field counted every human turn after the
> session's first tool call, so any session that was not one-shot approached
> its ceiling of `user_turns` minus sessions. Over this machine's transcripts,
> the 15 branches other than `main` with a human turn held 107 turns: the old
> rule called 93 of them corrective, the new one 14.
>
> *Measured 2026-10-27 — `aggregateInteraction` from `origin/main` and from
> schema version 4, over every main-session transcript under
> `~/.claude*/projects/*osn*`, grouped by `gitBranch`.*
>
> So `report`, `queries.sql` and the dashboard read an older card's count as
> unknown, and say how many cards they left out. `backfill` rebuilds a card at
> the current version from transcripts still on this machine, rewriting its
> spend and diff with it. A remote session's card cannot be rebuilt: its
> container took the transcripts with it.

Two supporting signals: a rising **cache-read share** across PRs means the
context surface — `AGENTS.md`, the skills, the wiki pages an agent opens — is
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
| `--resolve-issue` | Off. On, `gh` supplies the pull request, the issue and the summed rating — see [[#Which issue a card names, and what it divides by]] |
| `--complexity`, `--complexity-method` | Unset |
| `--phase` | `at-open` |
| `--if-absent` | Off. On, it exits without writing where the card already exists — the `SessionEnd` fallback's flag |

It never fails on missing transcripts — a card with a diff and zero spend is
still a true record, and it warns on stderr rather than exiting non-zero. It
does exit 1 when it cannot keep this pull request's records apart from another's
— see [[#One card per pull request]].

## Querying the cards

The committed files *are* the datalake. DuckDB reads them where they sit, so
there is no service to run and no free-tier cap to watch:

**`bun run --cwd tools/pr-metrics report` is the normal way in.** It computes
the nine analyses over the same cards, in TypeScript, and needs nothing
installed:

```bash
bun run --cwd tools/pr-metrics report               # all nine
bun run --cwd tools/pr-metrics report -- --waste    # just one
bun run --cwd tools/pr-metrics report -- --json     # structured, for an agent
```

`--json` emits the same tables as data, each keeping its `note`. The note is
not decoration — it holds the exclusions, and a consumer that reads only rows
will state a ranking's conclusion without its "18 cards excluded" qualifier.

The **`analyse-sessions` skill** is the way in for an agent: it runs the report,
reads coverage before anything else, and carries six traps, among them the
two behind wrong findings already drawn from this data.

That matters because **DuckDB does not exist in a remote session.** None of the
`duckdb` npm packages ship a binary — they are all libraries — so `bunx` is no
help and there is no `brew` in a cloud container. A report that only runs on one
laptop cannot tell you how the fleet is doing.

`queries.sql` is the same nine in SQL, and it is the better tool for a question
nobody anticipated. It is the optional local power tool, not the interface:

```bash
duckdb -init tools/pr-metrics/queries.sql     # local only; brew install duckdb
```

The two carry the same ratio definitions, duplicated on purpose. Change one,
change the other.

It defines `cards` (everything), `merged` (merged pull requests, by merge status) and `metrics` (the
shared ratios), then answers: where agents cost too much for the job; which
packages need a skill or a wiki page; whether briefs are getting clearer;
whether the context surface is bloating; cost per unit of declared difficulty;
whether delegation is paying off; model calls and their context; review findings acted on; and — run this one first — how much of the
history can be trusted at all.

Every per-pull-request distribution is summarised with a **median, never a
mean**. These are severely right-skewed: across the first 34 cards the median
was 3.6M tokens, the mean 15.4M and the maximum 92.7M. The mean described the
three largest pull requests and showed 8.5× month-over-month growth where the
median showed about 2×.

*Measured 2026-09-07 over the 34 cards that existed then. The mean and maximum
came from an ad-hoc pass, not a committed query; the median re-derives over
today's corpus with `bun run --cwd tools/pr-metrics report -- --context`.*

**The `cards` view declares the card's shape; it does not infer it.** Five
objects on a card are keyed by data: `spend.by_model`, `spend.effort` and
`interaction.tool_calls`, `.skills` and `.subagents`. One card can hold two keys
there that differ only in case, `Bash` and `bash`. DuckDB's struct fields are
case-insensitive, so `read_json_auto` stops on the duplicate name whenever it
infers one of those objects as a struct, and whether it does depends on the
DuckDB version and on which cards exist. The view declares the five as MAPs:
read a key with `interaction.tool_calls['Bash']`, or with dot access, and either
way the key's case counts.

A field the collector adds reaches `cards` only once
[`queries.sql`](../../tools/pr-metrics/queries.sql) declares it; a field it
drops reads NULL. `tests/queries-schema.test.ts` in the package fails until the
declaration and the card agree, and it needs no DuckDB, so CI runs it. To start
from nothing, read the raw JSON:

```sql
CREATE VIEW raw AS SELECT json FROM read_json_objects('.claude/metrics/*.json');
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

**Whether briefs are getting clearer** — prompts sent mid-turn over time. Read
`corrections` from the `metrics` view, which is NULL on a card before version 4
or with no human turn; `interaction.corrective_turns` read straight from `cards`
mixes two meanings:

```sql
SELECT date_trunc('month', at_ts) AS month,
       count(corrections) AS v4_prs,
       median(corrections) AS median_corrections,
       median(turns) AS median_turns
FROM metrics
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

- [[shared/observability/overview]] — the three observability rules
- [[conventions/review-findings]] — where a finding from a card gets filed
