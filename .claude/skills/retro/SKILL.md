---
name: retro
description: Use when running the retrospective on a piece of work that has just finished — the retro, normally the step straight after `prep-pr` opens the pull request — to write and commit the session-metrics card for the branch, read what the session actually cost against the difficulty declared before it started, and turn that into concrete changes to the skills, `CLAUDE.md`, the wiki, the tests or the brief. Also the owner of the card — nothing else writes one carrying the pull request's identity.
---

Run the retrospective for the branch named in `$ARGUMENTS`, or the current
branch if it is empty.

## What this run must produce

Two things, always, whatever else fails:

1. **The card.** `.claude/metrics/<branch-slug>.json`, carrying this branch's
   pull request number, issue number and issue labels — committed, pushed, and
   rendered onto the pull-request body as a `<details>` block. This skill owns
   that file. Step 1 is not optional and is not the part to drop when the run
   gets long.
2. **`RETRO.md`** at the repo root: the findings, each one naming the evidence
   in the card or the session that produced it, and each one landing somewhere
   — an issue, a file changed here, or a sentence addressed to the person who
   wrote the brief. It is gitignored scratch, like every other skill's report;
   the card is the half that the repository keeps.

A run that produces analysis and no card has failed. A run that produces a card
and no findings has **not** failed — "this session cost what the work was worth
and nothing here needs changing" is a real and common result, and inventing
three suggestions to avoid writing it is the single worst thing this skill can
do.

## Where this sits

`new-feat`, implement, `prep-pr`, then this. Under `orchestrate`, once per task,
after that task's pull request is open and before the shepherd watches it.

After `prep-pr` and not inside it, because `prep-pr` dispatches three review
agents: a card written before they finish measures building the change rather
than shipping it.

## Before Step 1 — what can actually run

Three answers, once, exactly as `prep-pr` establishes them:

```bash
git ls-remote --exit-code origin HEAD >/dev/null 2>&1 && echo "network: yes" || echo "network: no"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && echo "gh: yes" || echo "gh: no"
ls ~/.claude/projects >/dev/null 2>&1 && echo "transcripts: yes" || echo "transcripts: no"
```

**`transcripts: no` is the one that changes this run's shape.** The collector
reads `~/.claude/projects`, and where that directory is absent the card carries
the diff and zero spend — true, but it can answer nothing about cost. Say so at
the top of `RETRO.md`, write the card anyway (the diff half is still a record),
and confine the findings to what the *session* showed rather than what the card
counted. Never present a zero-spend card as a cheap session.

If `prep-pr` ran in this same session, it already has these three answers.
Re-probing costs a turn; read them out of its report instead.

---

## Step 1 — Write the card

This is the ownership step. Everything below is analysis; this is the durable
record, and it is written first so a run that ends early still leaves it behind.

```bash
BRANCH=$(git branch --show-current)
PR=$(gh pr view --json number --jq .number)
```

Then the two runs, which do different jobs:

```bash
# 1. The committed card. `--resolve-issue` finds the pull request, its first
#    linked issue and that issue's `complexity:` label for itself.
bun run --cwd tools/pr-metrics card -- --resolve-issue

# 2. The `<details>` block for the pull-request body, on stdout, warnings excluded.
bun run --cwd tools/pr-metrics card -- --resolve-issue --format markdown > /tmp/card.md
```

Four rules about that pair:

- **Let `--resolve-issue` do the lookup; never hand-roll it in the shell.**
  `.closingIssuesReferences[0].number` drops the repository, so a follow-up
  `gh issue view <n> --repo xchromo/osn` **succeeds** against a different
  repository's issue of the same number and writes a stranger's `complexity:`
  label in as this branch's denominator. `resolveIdentity` in
  `tools/pr-metrics/index.ts` compares the reference's own repository.
- **Labels are read only from an issue in this repository.** Most work here
  closes a finding in the private `xchromo/osn-tracker`, and that issue's
  `severity:`/`area:` labels must never reach a card committed to a public
  repository. The flag withholds them and records
  `complexity.method: "not-fetched"`, which is **not** `"none"` — a rating may
  well exist there and nobody looked. `"lookup-failed"` is its third answer,
  for a call that did not land.
- **Pass explicit flags only where you know better than `gh` does.** `--pr`,
  `--issue`, `--issue-labels` and `--complexity` all win over the lookup, and
  passing one turns the rest of it off. The usual reason is a branch whose pull
  request is not open yet.
- **Commit the JSON with the branch.** `~/.claude/projects` is local,
  unversioned and dies with a remote container. The committed file is the
  record; an uncommitted one is nothing. Stage the one card, never the
  directory: `.claude/metrics/` holds every other branch's card too, and a
  `git add` of the whole of it sweeps in anything a concurrent session left
  there.

```bash
git add ".claude/metrics/$(echo "$BRANCH" | tr -c 'a-zA-Z0-9._-' '-').json"
git commit -m "chore: session-metrics card for $BRANCH"
git push

gh pr view "$PR" --json body --jq .body > /tmp/body.md
cat /tmp/card.md >> /tmp/body.md
gh pr edit "$PR" --body-file /tmp/body.md
```

Read the body out and append to it — never compose a new one. The five sections
`prep-pr` wrote are the pull request's contract, and an edit that rebuilds the
body from memory loses them.

**Check the card is not already on the body** before appending — a re-run of
this skill would otherwise stack a second block. Match the summary line, not the
tag: a body that describes what this step does mentions `<details>` in its own
prose, and a bare `grep -c '<details>'` then reports a block that is not there.

```bash
gh pr view "$PR" --json body --jq .body | grep -c '^<details><summary>Session metrics'
```

The block is a `<details>`, never a `##` section: `prep-pr`'s body shape check
permits exactly five top-level headings, and appending a sixth fails a body
that is otherwise correct.

**When a step here cannot run**, record which and carry on — a missing card
never blocks anything. No `gh`: write the card with whatever identity you know
and leave the block in a file, naming it in `RETRO.md`. No transcripts: as
above. No network: commit the card locally; it pushes with the next push.

**The `SessionEnd` hook is a fallback, not a second writer.** It runs
`card -- --if-absent`, so it writes a card for a branch that has none and never
touches one this skill committed — it has no way to know the pull request, the
issue or the rating, and an unguarded run would strip all three. If you find a
card on a branch with `pr.number: null`, that is the hook's, and Step 1 is how
it gets replaced.

---

## Step 2 — Read the card before forming any opinion

```bash
cat ".claude/metrics/$(echo "$BRANCH" | tr -c 'a-zA-Z0-9._-' '-').json"
bun run --cwd tools/pr-metrics report -- --coverage     # where this card sits in the corpus
```

Write these down before going further. They are the evidence every finding
below has to cite:

| From the card | What it is |
|---|---|
| `complexity.declared` + `spend.usd_equivalent` | The whole comparison. Spend against difficulty declared **before** anyone knew the cost |
| `interaction.corrective_turns` | Human turns after the agent had already picked up tools. The one number here that measures the brief, not the model |
| `interaction.tokens_before_first_edit` and `sessions_with_observed_edit` | Exploration. **`null` means unobserved, not "all of it"** |
| `interaction.edit_churn.max_edits_one_file` | An agent building, or an agent lost |
| `interaction.skills` / `interaction.subagents` | What was invoked — and what conspicuously was not |
| `window.compactions` and `window.sessions` | Whether the context ran out, and how many restarts |
| `diff.files` split by bucket | Where the change actually landed |
| `spend.by_actor` | Whether delegation paid |

`references/card-signals.md` maps each of those to the question it answers and
the artefact a finding about it belongs in. Read it before Step 3.

Two readings that are wrong every time:

- **Cost is not waste without the declared rating.** A small diff, a high
  rating and a large spend is a hard problem that ended in a one-line fix, and
  it is fine. The same diff at `complexity:1` is the thing this whole system
  exists to find. Unrated, say "unrated, so I cannot tell".
- **One card is a sample of one.** Comparing it to the corpus is
  `analyse-sessions`, not this skill, and a claim about *the repository* needs
  that skill's coverage step first. Findings here are about **this session**.

---

## Step 3 — Where a finding may come from

Every finding names a moment. Not an impression, not a feeling that the docs
could be better — a specific thing that happened in this session, and the
artefact that would have prevented it.

The five sources, in the order they are worth mining:

1. **What was re-derived.** A fact the session worked out from the source that
   a wiki page, a `CLAUDE.md` row or a skill could have stated. This is the
   highest-yield source and the reason `tokens_before_first_edit` is on the
   card.
2. **What was corrected.** Every `corrective_turn` is a course correction that
   the brief did not prevent. Read the actual prompts — what did the person have
   to say that the task should have carried?
3. **What a gate caught late.** A `review-security`, `review-performance` or
   `review-tests` finding that a test, an oxlint house rule or a CI step could
   have caught before a review agent had to. `stress-plan` findings count
   double: a plan defect found by a second model is one the plan template
   could have asked about.
4. **What a page claimed and the code contradicted.** A stale wiki page the
   session read and then disproved. The fix is the page, in this branch, and
   `prep-pr`'s docs pass may already have done it — check before filing.
5. **What was invoked and still went wrong.** A skill that ran and did not
   prevent the mistake it exists to prevent. That is a `SKILL.md` gap, and it
   is the only evidence that reliably justifies editing one.

## Step 4 — The areas, and the signal that points at each

| Signal | Usually means | Where the fix goes |
|---|---|---|
| High `tokens_before_first_edit`, package with no wiki page | No map for that surface | A new `wiki/` page, and a row in `CLAUDE.md` §Wiki Navigation |
| A fact re-derived that one line could have stated | `CLAUDE.md` is missing a row, or the wiki page is missing a heading | Prefer the wiki page; `CLAUDE.md` only for something every session needs |
| `corrective_turns` ≥ 3 | The brief was unclear | **The prompt.** Say what the task should have carried. No issue — there is nobody to assign it to |
| A skill ran and the mistake happened anyway | The skill is missing a trap | That `SKILL.md`, as a named failure mode, not a general exhortation |
| A review finding a gate could have caught | Missing test, missing house rule, missing CI step | `tests/`, `tools/oxlint/house`, or `.github/workflows` |
| `edit_churn.max_edits_one_file` high on one file | The agent was lost in that file | Usually the file, not the docs — a shape nobody can hold in their head |
| `window.compactions` > 0 on a small task | The context surface is too wide for the job | What was loaded and did not need to be |
| `spend.by_actor.subagent` near zero on a big task | Delegation did not happen, or `TASK-BRANCH:` was missing | `orchestrate`, or the attribution marker |
| Rising cache-read share across recent cards | The context surface is bloating | `analyse-sessions` — a corpus question, not this one |

## Step 5 — The traps

**1. Do not rate the work you just did.** The same contamination that makes a
complexity rating worthless at pull-request time applies here: an agent scores
the task it struggled with as hard and the documentation it read as adequate.
The defence is that every finding names an artefact and a moment, never a
difficulty. "This was tricky" is not a finding. "The session read
`osn/api/src/lib/origin-guard.ts` three times because
`wiki/systems/rate-limiting.md` does not say which routes are exempt" is.

**2. A new skill is almost never the answer.** Skills are context that every
future session pays for, they are measured by evals, and one nobody invokes
twice is bloat with a scoring loop attached. Propose editing an existing skill,
or a wiki page. A *new* skill needs a procedure that will recur and that a
reader would otherwise get wrong — say which, or do not propose it.

**3. Do not retro an environment.** A gate recorded `not run — no package
manager` is a fact about the container, not a gap in the repository. Findings
about missing dependencies in a remote session are noise; the repository is not
where that is fixed.

**4. A suggestion with no owner is not a finding.** Same rule as a deferral: it
goes to an issue, or it is a change made on this branch, or it is a sentence
said to the person. A paragraph in a chat reply is discovered by nobody.

**5. Do not re-file what `prep-pr` filed.** Its Step 7 already opened issues for
every `S-`, `P-` and `C-` finding. This skill files what those findings *imply
about the process* — the missing gate, not the defect.

**6. Three findings is a lot.** Rank by what someone would actually do, cut the
rest, and say how many you cut. A list of nine is a list nobody reads.

---

## Step 6 — File what survives

| Kind | Where | Labels |
|---|---|---|
| A wiki page or `CLAUDE.md` change | Make it **on this branch** if it is small and the pull request is still open; otherwise an issue in `xchromo/osn` | `area:docs`, `product:` of the surface, `--type Task` |
| A missing test, house rule or CI gate | Issue in `xchromo/osn` | `area:ops` or `area:schema` as it fits, `--type Task` |
| A skill or agent-definition change | Issue in `xchromo/osn` | `area:ops`, `product:shared`, `--type Task` |
| Anything about the brief | **No issue.** It goes in `RETRO.md` and is said plainly in the reply | — |
| A security, performance or compliance defect | `xchromo/osn-tracker`, and only if `prep-pr` did not already file it | per `wiki/conventions/review-findings.md` |

Every issue carries a `complexity:` rating before work starts — invoke
`rate-complexity`, or apply `complexity:unconfirmed` on an unattended run. Every
issue body stands on its own: name the file and line, state the concrete fix,
spell out what the evidence was. "The retro found this" is not a body.

Where the next step needs a choice only the repo owner can make, write what you
propose, apply `needs:decision`, and move on.

## Step 7 — Report

`RETRO.md`, in this shape:

```markdown
# Retro — <branch>

**Card** — `.claude/metrics/<slug>.json`, committed as <sha>. <One line: what it
cost, against what was declared, and whether those agree.>

**Gates** — transcripts: yes/no. gh: yes/no. <Anything the card could not see.>

## Findings

### 1. <what to change> — <area>

- **Evidence** — the moment in this session, and the card field or the turn that
  shows it.
- **Cost** — what it cost this time. A number where the card has one.
- **Fix** — the concrete change, in a named file.
- **Landed** — `xchromo/osn#N`, or "changed on this branch", or "told the user".

### 2. …

**Cut** — <n> findings not worth the reader's time. <One line on the kind.>
```

Then say it in the reply, shortest first, and put anything about the brief to
the person directly — that one never reaches an issue, so if it is not in the
reply it is nowhere.

## What this reads and feeds

`wiki/observability/session-metrics.md` is the reference for every field and
for why the card holds exactly one scalar judgement.
`tools/pr-metrics/README.md` has the commands. **`analyse-sessions` is the
corpus-level counterpart**: this skill looks at one session and may propose a
change to one artefact; that one looks at every card and is the only thing
entitled to say a *trend* exists. A retro finding repeated across three
branches is an `analyse-sessions` question, not a stronger retro.
