---
name: prep-pr
description: Use when preparing the current branch for a pull request — resolving the base branch, checking changesets, running builds and reviews, filing findings as issues, and opening the PR with the mandatory five-section body that the write-pr skill writes.
---

Prepare the current branch for a pull request.

## What this run must produce

Two files, always, whatever else fails:

1. A **PR body** with exactly five `##` sections, filled in at Step 8 with the
   `write-pr` skill.
2. A **report** of what was checked, what would fail in CI (named exactly, with
   its fix), and whether the branch is ready.

If the task named the files, use those names; otherwise `PR-BODY.md` and
`PREP-PR-REPORT.md` at the repo root.

**Write the PR body's skeleton now, before Step 0.** The body is the
deliverable, and a body missing a section has failed however good the run was.
Creating it first means the shape is already right and every later step only
fills it in; leaving it to Step 8 is how a section goes missing on a run that
spent its turns elsewhere. Copy this verbatim:

```bash
cat > PR-BODY.md <<'EOF'
## Summary

None

## Workspaces affected

None

## Issues

None

## Decisions

None

## Test plan

None
EOF
```

Those five `##` headings are the whole permitted set, and that is their order.
Replace a `None` as the run establishes what belongs there; leave it where the
answer really is nothing. Never add a sixth `##` — notes about gates that could
not run go in the report file, and a change-specific title goes in the PR title
and in `## Summary`, never as a heading of its own.

**From here on this file is only ever edited, never rewritten.** Every later
step replaces a `None`, or inserts text under a heading that already exists —
the one exception is an owner action, which `write-pr` puts above `## Summary`.
Do not compose the body in your head and write it out whole at Step 8 — a
single write to `PR-BODY.md` discards the shape this step just established, and
that is the one way this run fails outright however good the preparation was.
If you find yourself about to write the whole file, you have lost the skeleton:
read it back first and edit what is there.

**A decision is a `###`, never a `##`.** The Decisions template in `write-pr`
uses one `###` heading per decision, inside `## Decisions`. Promoting one to `##` adds a
top-level section, and a body whose decisions each became a heading fails the
shape check with five correct sections still sitting in the file.

## When a step cannot run

The steps below assume a network, `gh`, an installed package manager, and a user
to answer questions. Any of those may be absent.

**Find out which, once, before Step 0.** Discovering it by failing costs a turn
per step:

```bash
git remote -v && git ls-remote --exit-code origin HEAD >/dev/null 2>&1 && echo "network: yes" || echo "network: no"
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && echo "gh: yes" || echo "gh: no"
[ -d node_modules ] && echo "deps: installed" || echo "deps: absent"
```

Write the three answers into the report under a heading of their own. They
decide in advance which steps run for real and which run their static
equivalent, and **a step whose gate you already know is unavailable is run
statically and immediately, not attempted.** Never retry a command whose
prerequisite the probe ruled out, and never describe as done anything it ruled
out.

**No step is a stop, and no step is skipped.** A blocked gate still gets its
static equivalent — read the code the gate would have exercised and state your
own verdict — and then a line in the report naming the step, what could not run,
and what you concluded without it. "Not run" describes the gate, never your
review: a run that records six "not run" lines and no analysis has failed as
surely as one that stalled waiting. Those notes go in the report file; none of
them becomes a section of the PR body. Both artefacts are produced in every
case, including the one where every gate failed.

**A static equivalent is a paragraph, not an expedition.** With no network the
issue steps are the issue you *would* file — title, labels, type, four-field
body — written into the report, not a hunt through the tracker. If the task also
forbids modifying files, the docs step is the same: name the pages this branch
would change and say what would go in them. Neither is a reason to read the
wiki, and neither is a reason to dispatch an agent.

Five steps ask the user something. With no user, take the conservative default
that step names, record the choice under `## Decisions`, and continue. Waiting
for an answer that cannot come is a failed run.

Run the steps in order.

---

## Step 0 — Resolve the base branch

Every later step diffs against the branch this PR merges **into**, which is not
always `main`.

```bash
BASE=$(git config --get branch.$(git branch --show-current).gh-merge-base || echo main)
git fetch origin "+refs/heads/${BASE}:refs/remotes/origin/${BASE}"
DIFF_BASE=$BASE
git merge-base --is-ancestor "$BASE" "origin/$BASE" 2>/dev/null && DIFF_BASE="origin/$BASE"
echo "base: $BASE, diff against: $DIFF_BASE"
```

**Diff against `$DIFF_BASE`, never `$BASE`.** It is `origin/$BASE` when the
local branch is behind it, and the local branch otherwise. Local `main` lags
`origin/main` in the worktree layout — it moves only when someone pulls in
`main/` — and a diff against it counts every commit between the two as this
branch's: another pull request's files, its changeset, its comment lines. A
stacked parent is the reverse: its newest commits may be local and unpushed, and
one never pushed has no `origin/` ref. If the fetch fails, the rule still works
on the refs already there.

Keep `${BASE}` in braces in the refspec: zsh reads `$BASE:r` as a modifier and
fetches a ref that does not exist. The explicit refspec updates `origin/$BASE`
even where the clone maps no remote-tracking refs, as a fresh `git clone --bare`
does. Never fetch into the local branch (`origin main:main`): git refuses to
update a branch checked out in another worktree.

If `BASE` is not `main` this branch is stacked, and two things follow — put both
in the report, naming `$BASE`, whether or not you can act on them. The PR targets
`$BASE`, not `main`; and **the parent's own PR has to exist first**, because
GitHub cannot base a pull request on a branch it does not have. With no network
that ordering is still the finding: state it.

If the branch is stacked but `gh-merge-base` was never set — it is written at
worktree creation, see `wiki/conventions/stacked-prs.md` — set it now rather
than passing the base by hand:

```bash
git config branch.$(git branch --show-current).gh-merge-base <parent-branch>
```

Use `$DIFF_BASE` in every `git diff` and `git log` below, and `$BASE` as
`--base` in Step 9.

---

## Step 1 — Identify changed workspaces

```bash
git diff --name-only "$DIFF_BASE"...HEAD
```

A file under `<dir>/<name>/` belongs to the workspace `<dir>/<name>`, and its
package name is whatever that directory's own `package.json` says — read it,
never guess it, because the path does not always give it (`tools/oxlint/house`
is `@tools/oxlint-house`). `cire/*` packages are **ignored** by changesets:
version-less, so they never share a changeset with a versioned package.

Files on the changeset **allowlist** need no changeset at all.
`scripts/changeset-required.sh` holds the list and decides — run it rather than
reasoning about it. Anything off the list, including `bun.lock` and root
`turbo.json` / `tsconfig.json`, still requires one.

Report the affected workspaces and whether any CI/infra-only files changed.

## Step 2 — Check changesets

**Diff the working tree, not the commit range, while anything is uncommitted.**
`"$DIFF_BASE"...HEAD` describes what has been committed, so on a branch whose
work is still in the tree it is empty — and `scripts/changeset-required.sh` answers
`skip` for an empty diff exactly as it does for an all-allowlisted one. This is
a gate whose failure mode is passing, and Step 3 is what commits, so the plain
form here is wrong every time this skill runs before a commit. CI then fails the
pull request on "no changeset found" after a push and a review cycle.

```bash
CHANGED=$(git status --porcelain --untracked-files=all | grep -q . \
  && git diff --name-only --cached HEAD \
  || git diff --name-only "$DIFF_BASE"...HEAD)

echo "$CHANGED" | grep '^\.changeset/'   # minus config.json, README.md
bash scripts/validate-changesets.sh
```

Stage first (`git add -A`) so `--cached` sees everything; Step 3 commits what is
staged. Re-run the check after that commit if anything was left out.

The same ordering catches Step 5's `comment-delta.ts`, which reads the commit
range too and reports a stale figure until the work is committed.

`validate-changesets.sh` is the authority and needs no network and no install —
shell and `jq`. It fails on exactly the two mistakes CI catches: a package name
that is in no workspace, and one changeset mixing an ignored (version-less)
package with a versioned one. Your own reading of the frontmatter is the
cross-check, not the verdict.

**A name that does not match a `package.json` `name` field fails CI** at
`changeset version` with "package not in workspace" — `osn-api` where the
package is `@osn/api`. Verify each with `jq -r .name <workspace>/package.json`.

If no changeset exists: run `scripts/changeset-required.sh` first, piping the
same `$CHANGED` list. If it says `skip`, none is needed — say so and do not
create an empty one. **A `skip` on an uncommitted branch means you diffed the
wrong thing**, not that the branch is allowlisted; `bun.lock` and a workspace
`package.json` are both off the list and both are easy to forget. Otherwise draft
a one- or two-sentence summary, confirm it with the user, and run
`bun run changeset`. With no user, adopt your draft, note in the report that it
was unconfirmed, and continue. If a changeset exists but misses an affected
package, say which.

## Step 3 — Commit uncommitted changes

Run `git status --porcelain`. If anything is uncommitted, group it into logical
commits rather than staging everything at once, and confirm the grouping with
the user first — the recipe is in `references/workflow-steps.md`. With no user,
or if you were told not to commit, leave the tree alone and record the
uncommitted files in the report. Never run bare `git stash` / `git stash pop`:
the stash stack is shared with every other worktree of this repo, so a pop can
take someone else's work. Your own report and PR-body files are expected to be
uncommitted and are never grouped into a commit.

## Step 4 — Build, test, and review test surface

**Size the diff first.** A review agent costs about the same whatever it reads, so a branch that changes only docs, skills and tests does not get all three:

```bash
{ git diff --name-only --no-renames "${DIFF_BASE:?run Step 0 first}"...HEAD
  git diff --name-only --no-renames HEAD
  git ls-files --others --exclude-standard; } | sort -u | bun run scripts/review-scope.ts
```

The second and third lines add work still uncommitted; `--no-renames` keeps the old path of a moved file. The script decides — run it rather than reasoning about it:

| Verdict | Step 4 | Step 6 |
|---|---|---|
| `full` | The `review-tests` agent, as below | Both agents |
| `trivial-tests` | The `review-tests` agent, as below | No agents |
| `trivial` | No agent: run the gates inline | No agents |

Trivial means every changed path is a Markdown file (`*.md`, `*.mdx`), a file under `.claude/skills/`, or a test — a path through a `tests/` directory, or a `*.test.*` or `*.spec.*` file. Nothing under any `src/` directory, nothing under `.github/workflows/`, no `package.json` and no lockfile qualifies, whatever its name or extension; neither does anything under `.agents/`, `.claude/agents/` or `.claude/metrics/`. So a one-line change to auth, a schema, a route, a Worker binding or a build config always gets every review.

On `trivial`, run the gates inline instead: Step 2's changeset check, `bun run scripts/skill-evals.ts check-names` when a skill changed, and the wikilink check in `references/wikilink-check.md` when a wiki page changed. Each review that did not run gets its `## Test plan` row as `inline — trivial diff`, with one sentence of your own verdict on the diff.

Otherwise, dispatch a **`reviewer`** agent (`.claude/agents/reviewer.md`) to run the `review-tests` skill (`.claude/skills/review-tests/SKILL.md`), passing the list of affected workspace paths as arguments and stating that it is alone in the worktree, so it may build and run tests. Pass no `model` or `effort`; the definition sets both. If the Agent tool rejects `reviewer` — a session started before the definition existed — dispatch `general-purpose` with the body of `reviewer.md` pasted into the brief; it carries the rules but not the tool limit. Open the dispatch prompt with `TASK-BRANCH: <branch>` on its own line — the collector reads it back out (`tools/pr-metrics/index.ts`, `resolveDispatchBranch`) to attribute this review's spend to the branch's card; without it the spend banks against whatever branch the dispatching session happened to be on.

**Unless the task says the reviews have already run.** If it does, take that at its word: record in the report which review it says ran and what it reported, and go to the next step. Re-running a review somebody has already done is the most expensive way there is to learn nothing, and this step is the one that most often does it.

Wait for it to complete. If the build fails or any tests fail, record the failures in the report and in `## Test plan`, and continue. If the tooling itself is unavailable — no package manager, no dependencies installed — record every gate as **not run**. That is the honest `## Test plan` entry, and it is never a tick.

If coverage gaps are reported, present them to the user and ask whether they want to address them before continuing.

---

## Step 5 — Check for unrelated changes

If the changed workspaces span clearly unrelated domains — backend packages
mixed with an unrelated frontend feature, infra bundled with feature work — put
the concern to the user and let them decide whether to split. With no user,
record the observation under `## Decisions` and continue. The wording is in
`references/workflow-steps.md`.

### Comment-line delta

Print how many comment lines the branch adds and removes:

```bash
bun run scripts/comment-delta.ts "$DIFF_BASE"
```

Report the net figure in the PR body's test-plan table. **This is a number to
look at, not a gate** — there is no threshold to pass, and no cleanup is
required to come out negative. Moving misattached doc blocks can touch
hundreds of comment lines and net near zero, and that is correct.

It exists because a comment-cleanup branch that *grows* comment volume is worth
a second look before a human opens the diff, and nobody had been measuring it.
The failure it catches is real and was measured: a batch instructed to "rewrite
each reference to the constraint it stood for" turned single-line
parentheticals into paragraphs and added 66 comment lines net while reporting
itself as a cleanup.

Three traps in reading the number:

- **Diff it against the branch point, not a moved base.** If the base branch has
  been force-pushed since the branch was cut, `git merge-base` falls back to an
  older ancestor and sweeps the base's own commits into the count. That produced
  a reported `+85` for a branch actually running `-40`. Step 0 resolves
  `$DIFF_BASE`; use it, and if the number looks surprising, check
  `git log "$DIFF_BASE"..HEAD` contains only your commits.
- **Diff it against `$DIFF_BASE`, not local `main`.** A branch rebased onto a
  newer `origin/main` and diffed against a lagging local `main` counts another
  pull request's comment lines as its own: `+285/-9` reported for a branch
  running `+187/-0`.
- **It is trivially gamed** by joining wrapped lines, which is why it is not a
  gate. A branch that halves its comment lines by rewrapping has done nothing.

## Step 6 — Parallel reviews

**Unless the task says these reviews have already run** — then record what it says they found in the report, and go to Step 7. A finding reaches the PR body only in the form `write-pr` allows.

**Unless Step 4 sized the diff `trivial` or `trivial-tests`** — then dispatch neither agent. The Performance and Security rows of `## Test plan` read `inline — trivial diff`, each with one sentence of your own verdict, and you go to Step 7.

Otherwise run the following two **`reviewer`** agents **in parallel** using the Agent tool, as Step 4 describes.
Open each dispatch prompt with `TASK-BRANCH: <branch>` on its own line, for
the same reason as Step 4's — the collector reads it back out to attribute
the reviewer's spend to this branch's card. Tell each that it is **not** alone
in the worktree, so it builds nothing; a number it needs from a build is yours
to measure afterwards:

**Agent 1 — Performance review** (`reviewer` agent):
Invoke the `review-performance` skill (`.claude/skills/review-performance/SKILL.md`) and execute its instructions, passing the list of affected workspaces and the branch name as context.

**Agent 2 — Security review** (`reviewer` agent):
Invoke the `review-security` skill (`.claude/skills/review-security/SKILL.md`) and execute its instructions, passing the list of affected workspaces and the branch name as context.

Wait for both agents to complete. Present both reports to the user in full, using the finding IDs from each review (e.g. S-H1, P-W2) so they can be referred to in discussion, in the report and in the tracker issues Step 7 files. The PR is public and never carries a finding ID; `write-pr` says what it carries instead.

**A `critical` or `high` finding is not deferrable.** Fix it on this branch, or open the follow-up pull request immediately and link it from this one before either merges. That is the whole option set — filing it and continuing is not in it, and neither is "out of scope for this branch". A filed-and-open `high` is a live unpatched defect whose location is now written down; the issue is an attack map with a timer on it. `medium` and below may be filed and scheduled.

Severity comes from the tier letter in the finding ID, assigned by the review before anyone knows what fixing it costs. Re-rating it afterwards to make it deferrable is the failure mode this rule exists to prevent — the same contamination as re-rating an issue's complexity once its token cost is on screen.

Ask the user: "Do you want to address any findings before pushing?" If yes, pause and let the user make changes, then re-run steps 3 and 4 before continuing. With no user, fix every `critical` and `high` on the branch and re-run steps 3 and 4; list what you fixed and what you deferred in the report, file each as Step 7 says, and continue. A run that cannot fix them — no tooling, no network — says so plainly and names them as blocking rather than reporting the branch ready.

---

## Step 7 — File the findings as issues

Work is tracked in GitHub Issues, not in a markdown checklist. Two repos:

| Kind of item                          | Repo                                |
| ------------------------------------- | ----------------------------------- |
| Review findings — `S-*`, `P-*`, `C-*` | **`englishstventures/osn-tracker`** (private) |
| Planned work, features, bugs          | **`englishstventures/osn`** (public)          |

`englishstventures/osn` is public. A finding names an unpatched route, so filing one there publishes it. **Route by kind, not by severity** — an `S-`, `P-`, or `C-` ID always goes to the tracker, however minor it looks.

Auditing a defect class — when a finding is an instance of a class, enumerate the *shapes* the defect can take rather than re-grepping the first form you found. Recipe and the D1 bind-cap case study: `references/auditing-defect-classes.md`.

### New findings from Step 6

One tracker issue per finding, so that its record stays private and the public PR body can carry it as a bare reference:

- each finding this branch does **not** fix;
- each finding it **fixes** that has no issue yet — filed before the PR opens, so the merge closes it;
- each finding **dismissed** as no defect — filed, then closed at once as not planned (`gh issue close <n> --repo englishstreetventures/osn-tracker --reason "not planned"`), with the reasoning in its body.

Title leads with the finding ID; the body is the four fields.

Write each one with the **`write-issue`** skill: it holds the rules for a body that stands on its own months later, and the faults to avoid. The four fields and the labels below are the finding's own, from `wiki/conventions/review-findings.md`. A worked `gh issue create` for a finding is in `references/issue-filing-example.md`.

Labels, exactly one of each:

- `area:` — `security` for `S-*`, `performance` for `P-*`, `compliance` for `C-*`
- `severity:` — from the ID prefix per `wiki/conventions/review-findings.md`: `C` → `critical`, `H`/`W` → `high`, `M` → `medium`, `L` → `low`, `I` → `info`
- `product:` — `osn-core`, `pulse`, `cire`, `zap`, `shared`, or `landing`

`--type`, exactly one — an org-level field the Project groups and filters on, separate from the labels:

- **`Bug`** for an `S-*` or `P-*` finding: something behaves wrongly and wants fixing
- **`Task`** for a `C-*` compliance item, and for any finding filed at `severity:info` — it records an observation and asks for no fix

### A deferral leaves an issue behind, not a paragraph

Anything this branch decides **not** to do — a finding you are not fixing, a rule
left at `warn`, a limitation you are accepting, a workaround standing in for the
real fix — gets an issue, and the code carries the link and nothing more
(`// Bounded until englishstventures/osn#412 lands.`). A comment that explains the deferral
instead has no owner and appears in no backlog, so it is found only by whoever
next opens the file.

A settled decision with a reason is different and stays inline with no issue —
the test is whether the sentence implies future work. "For now", "until",
"eventually", "ideally" are deferrals wearing an explanation. Full convention:
`wiki/conventions/code-comments.md`.

Never link a tracker finding from a file in the public repo; the link is the
disclosure. State the constraint and leave the finding unnamed.

### The rest of Step 7

Findings this branch **fixes** are closed by the merge, not by hand: their
tracker issues go in the PR body as bare
`Closes englishstreetventures/osn-tracker#<n>` lines (`write-pr`). A fixed finding that
predates the branch already has an issue — find it by ID, since the ID leads the
title. Planned work this branch completes goes in the same list, as `Closes #N`
from the public repo. **Never delete an issue**; close it.

`references/workflow-steps.md` carries the rest: the `gh issue list` searches,
the Up Next promotion, and the docs pass — what to check in `AGENTS.md` and the
wiki, and how to verify the wikilinks you wrote resolve.

Report the issues opened and the issue numbers this branch closes — Step 8 needs
both.

## Step 8 — Write the PR body

**Do this even when you cannot push.** The body is the deliverable; opening the pull request is only how it is delivered. Write it to the file whichever way the run ends — no network, no `gh`, failing gates, nothing committed.

Invoke the **`write-pr`** skill and follow it. It owns the title and the body: what each of the five sections holds, the `Closes` and `Part of` lines, owner actions, the test plan, and the checks to run before sending. Derive both from the branch's commit history (`git log "$DIFF_BASE"..HEAD --oneline`) and everything this run established.

The skeleton is already on disk from the top of this file. Fill it in — do not write a second body beside it.

One rule from `write-pr` is repeated here because a public body that breaks it cannot be taken back: a tracker issue appears only as a bare reference — `Closes englishstreetventures/osn-tracker#<n>` for one this branch fixes — never with its finding ID, its title, or a word about the defect.

**Every test-plan row is filled in from a command you ran in this worktree, in this run.** A gate you did not run is `NOT RUN` with the reason, and a run where nothing could execute is a table of `NOT RUN` rows — a correct and complete test plan. Never write a tick, a "passes", or a pass count you did not watch appear: an invented green gate is the one failure in this document a reviewer cannot detect.

### The session metrics are not this step's job

`retro` writes the card after Step 10, appends its `<details>` block to the
pull request and commits the JSON. Leave the body without it — no placeholder,
and do not run the collector to save a step: a card on disk with no pull
request or issue on it is the one thing that makes `retro`'s job harder.

### Check the body before you finish

```bash
grep -c '^## \(Summary\|Workspaces affected\|Issues\|Decisions\|Test plan\)$' <body-file>
grep -c '^## ' <body-file>
```

Both must print `5`. A first count under 5 means a section is missing, renamed, or demoted to `###`. A second count above 5 means you added a top-level section of your own — the most common one is a place to park notes about gates that could not run, and those belong in the report file instead. Custom top-level headings are not allowed: a change-specific title goes in the PR title and in `## Summary`, never as a `##` of its own.

---

## Step 9 — Push and open the PR

```bash
git push -u origin HEAD
```

Then open it with `write-pr` Step 6's REST command, passing `$BASE` as `base` —
the REST call has no default and reads no git config, so a stacked branch that
omits it is refused rather than opened — and run that step's check that GitHub
registered every `Closes` line.

With no network or no `gh`, record that the PR was not opened, name the base it
should target, and leave the body file in place. That is a complete run.

Confirming the base took, and registering a stack when `$BASE` is not `main`,
are in `references/workflow-steps.md`. Report the PR number, its base branch,
whether the stack is registered, the issues it closes, and any close it could
not make — a tracker line the classifier refused, or a stacked PR's closes —
so the owner can make it by hand.

---

## Step 10 — Hand off to `retro`

Invoke the **`retro`** skill (`.claude/skills/retro/SKILL.md`) with the branch
name and the pull request number. It writes and commits the session-metrics
card, appends the `<details>` block to the body this run just opened, and reads
what the session cost against the complexity declared before it started.

This is not optional tidying. The card is the only durable record of what the
work cost — `~/.claude/projects` is local, unversioned, and dies with a remote
container — and this is the last moment it can be written with the pull
request's identity on it. A branch whose retro never ran leaves the
`SessionEnd` hook to write an identity-less card, which lands in the corpus
looking complete and answering nothing.

Where the PR could not be opened, invoke it anyway: the card is written from
the branch and the transcripts, not from GitHub.
