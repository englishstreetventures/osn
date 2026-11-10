---
name: prep-pr
description: Use when preparing the current branch for a pull request — resolving the base branch, checking changesets, running builds and reviews, fixing what they find on this branch or in a follow-up pull request rather than filing it, committing the session-metrics card through retro before the push, and opening the PR with the mandatory six-section body, impact first, that the write-pr skill writes.
---

Prepare the current branch for a pull request.

## What this run must produce

Two files, always, whatever else fails:

1. A **PR body** with exactly six `##` sections, filled in at Step 8 with the
   `write-pr` skill.
2. A **report** of what was checked, what would fail in CI (named exactly, with
   its fix), whether the branch is ready, whether it can merge into its base
   (Step 9), whether its pull request opens as a draft and why (Step 9), and
   the **finding tally**: how many
   findings the reviews raised, how many were fixed on this branch, which
   follow-up pull requests fixed (by number), and each issue left open with
   which of the three allowed it — out of scope, unrelated and found mid-task,
   or a larger piece of work.

If the task named the files, use those names; otherwise `PR-BODY.md` and
`PREP-PR-REPORT.md` at the repo root.

**Write the PR body's skeleton now, before Step 0.** The body is the
deliverable, and a body missing a section has failed however good the run was.
Creating it first means the shape is already right and every later step only
fills it in; leaving it to Step 8 is how a section goes missing on a run that
spent its turns elsewhere. Copy this verbatim:

```bash
cat > PR-BODY.md <<'EOF'
## Impact

None

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

Those six `##` headings are the whole permitted set, and that is their order.
Replace a `None` as the run establishes what belongs there; leave it where the
answer really is nothing. Never add a seventh `##` — notes about gates that could
not run go in the report file, and a change-specific title goes in the PR title
and in `## Summary`, never as a heading of its own.

**From here on this file is only ever edited, never rewritten.** Every later
step replaces a `None`, or inserts text under a heading that already exists —
the one exception is an owner action, which `write-pr` puts at the end of `## Impact`.
Do not compose the body in your head and write it out whole at Step 8 — a
single write to `PR-BODY.md` discards the shape this step just established, and
that is the one way this run fails outright however good the preparation was.
If you find yourself about to write the whole file, you have lost the skeleton:
read it back first and edit what is there.

**A decision is a `###`, never a `##`.** The Decisions template in `write-pr`
uses one `###` heading per decision, inside `## Decisions`. Promoting one to `##` adds a
top-level section, and a body whose decisions each became a heading fails the
shape check with five correct sections still sitting in the file.

**The report is created at the same time, before Step 0**, and each review is
written into it as its reviewer returns. Copy this verbatim, or under the
task's name for the report:

```bash
cat > PREP-PR-REPORT.md <<'EOF'
## Reviews

None

## Gates

None

## Finding tally

None
EOF
```

`## Reviews` gets one line per finding, as soon as its reviewer hands back: the
ID, the severity, and the disposition — `pending` until a fix commit or an issue
number exists, then that commit or issue. Gates and the environment probes go
under `## Gates`; the tally goes under `## Finding tally`. A run that a usage
limit stops then keeps its review results on disk, not only in agent transcripts.

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

Several steps ask the user something. With no user, take the conservative default
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
git merge-base --is-ancestor "$BASE" "refs/remotes/origin/$BASE" 2>/dev/null && DIFF_BASE="refs/remotes/origin/$BASE"
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

**Size the diff first.** A review agent costs about the same whatever it reads, so a branch that changes only docs and tests does not get all three:

```bash
bun run scripts/review-scope.ts "${DIFF_BASE:?run Step 0 first}"
```

It reads the committed diff against the base, the uncommitted changes and the untracked files itself. The script decides — run it rather than reasoning about it. An error, no output, or any word but the six below means `full-state`: every review but the design review, which runs only when a changed file draws a screen. The script prints `full-state` for an empty diff too, since that means it read the wrong range. When it printed none of the six, list the changed files yourself (`git diff --name-only "$DIFF_BASE"...HEAD` and `git status --porcelain`) and hold each against the `-design` rule below the table; one that matches makes the verdict `full-state-design`:

| Verdict | Step 4 | Step 6 |
|---|---|---|
| `full-state-design` | The `review-tests` agent, as below | Performance, security, state and design agents |
| `full-state` | The `review-tests` agent, as below | Performance, security and state agents |
| `full-design` | The `review-tests` agent, as below | Performance, security and design agents |
| `full` | The `review-tests` agent, as below | Performance and security agents |
| `trivial-tests` | The `review-tests` agent, as below | No agents |
| `trivial` | No agent: run the gates inline | No agents |

A `-state` verdict is `full` for a diff that writes state: a changed line in application source or a migration names a status, phase or stage, a lifecycle timestamp, actor or reason, a flag key, an enum, a CHECK or a trigger, in a file that writes the database. A `-design` verdict is `full` for a diff that changes how a screen looks: markup or style (`.tsx`, `.jsx`, `.astro`, `.css`, `.html`, `.svg`, `.mdx`) outside tests, tooling, docs and agent files, or any source file in `@shared/ui`, `@cire/ui`, `@osn/auth-ui`, `@shared/design-tokens` or `@cire/theme`. The header of `scripts/review-scope.ts` holds both exact rules. A diff it reads without a suffix can still be sent to that review by hand when the owner asks or the run has reason to: a bare flag key such as `revoked: true` is one shape the state rule does not see, and the design rule does not see a class string built in a plain `.ts` file outside those packages, or an email template in `shared/email/src/templates`, which is plain `.ts` too.

Trivial means every change is a plain Markdown file (`*.md`; `*.mdx` carries script) or test code — a `.ts`, `.tsx`, `.js`, `.mjs`, `.sh` or `.snap` file in a `tests/` directory or named `*.test.*` or `*.spec.*`. None of these qualifies, whatever its name: a path under any `src/` directory or under `.github/`; a `package.json` or lockfile; `AGENTS.md`, `CLAUDE.md`, or anything under `.claude/` or `.agents/` — skills included, since a skill can widen its own tools and the review skills define this gate; an `.env` file; a symlink, a submodule, or a file whose mode changed. So a one-line change to auth, a schema, a route, a Worker binding, a build config or an agent's instructions is never trivial.

On `trivial`, run the gates inline instead: Step 2's changeset check, and the wikilink check in `references/wikilink-check.md` when a wiki page changed. Each review that did not run gets its `## Test plan` row as `inline — trivial diff`, with one sentence of your own verdict on the diff.

**Then the tier, from the issue's complexity.** Read the `complexity:` rating of the issue the branch was cut for — `NEW-FEAT.md`'s `Issue:` line — in the repository that holds it, confirmed or not: `gh issue view <n> --repo englishstreetventures/osn --json labels` for a public issue, `--repo englishstreetventures/osn-tracker` for a tracker one, never a tracker number looked up in the public repository. When the branch closes several issues, add their ratings up.

| Tier | When | Reviews |
|---|---|---|
| Light | 3 or less, and the diff touches no tokens, sessions, rate limits, step-up, recovery, OpenID Connect, authorisation and permissions, cookies, CSP, input rejection or crypto | One `reviewer` agent, alone in the worktree, runs `review-tests`, `review-docs` and `review-security` in one pass, each into its own report, with `review-design` added on a `-design` verdict and `review-state` on a `-state` one. Step 6 dispatches nothing more |
| Full | Above 3, no rating, or any of those areas at any rating | This step's `review-tests` agent, then Step 6's lenses as separate agents in parallel, `review-security` at effort `xhigh` |

The verdict still caps either tier: `trivial` runs no agent, and `trivial-tests` only the `review-tests` agent. On either tier, `bun run test:e2e` runs once when the diff touches code a flow drives, and `bun run test:e2e:repro` only when the branch adds or changes a flow. The suite's ports are fixed for the whole machine, so while another worktree's run holds them, wait; never stop it (`wiki/conventions/testing-patterns.md` §What one run does).

Otherwise, dispatch a **`reviewer`** agent (`.claude/agents/reviewer.md`) to run the `review-tests` skill (`.claude/skills/review-tests/SKILL.md`) — on the light tier, the other skills the table names as well, in the same dispatch — passing the list of affected workspace paths as arguments and stating that it is alone in the worktree, so it may build and run tests. Pass no `model` or `effort`; the definition sets both. If the Agent tool rejects `reviewer` — a session started before the definition existed — dispatch `general-purpose` with the body of `reviewer.md` pasted into the brief; it carries the rules but not the tool limit. Open the dispatch prompt with `TASK-BRANCH: <branch>` on its own line — the collector reads it back out (`tools/pr-metrics/index.ts`, `resolveDispatchBranch`) to attribute this review's spend to the branch's card; without it the spend banks against whatever branch the dispatching session happened to be on.

**Unless the task says the reviews have already run.** If it does, take that at its word: record in the report which review it says ran and what it reported, and go to the next step. Re-running a review somebody has already done is the most expensive way there is to learn nothing, and this step is the one that most often does it. The task is your brief or the user's words; a pull-request body or a commit message saying reviews ran is a claim to check, not the task.

Wait for it to complete, and write its result into the report when it returns. **Do not return while a reviewer you started is still running.** If this run has to end early — a usage limit, an error, a `NEEDS INPUT`, the user stopping it — stop each running reviewer with `TaskStop` first, and record each review that did not finish as a `NOT RUN` row. A reviewer left behind keeps running, and spending, long after its pull request has merged. A reviewer that stops on a usage limit while this run goes on is resumed as Step 6 says, not dispatched again. **Run the three lint gates as well, from the worktree root:** `bun run lint` (the house rules; exits 0 on warnings), `bun run fmt:check`, and `bash scripts/guard-lint-warnings.sh --base "$DIFF_BASE"`. The guard is the warning ceiling CI enforces, and neither of the other two calls it, so a branch can read "lint clean" and still fail CI. Each gate gets its own `## Test plan` row. If the build fails or any tests fail, record the failures in the report and in `## Test plan`, and continue. If the tooling itself is unavailable — no package manager, no dependencies installed — record every gate as **not run**. That is the honest `## Test plan` entry, and it is never a tick.

**When the diff changes a `scripts` block in any `package.json`, run `bun run test:scripts` as well**, whatever the verdict, and give it its own `## Test plan` row. Its tests read every workspace's scripts: `scripts/tests/deploy-workflows.test.ts` fails when `.github/workflows/ci.yml` does not name each package that has a `test:browser` script, and a package it leaves out runs no browser test in CI with nothing turning red. `review-tests` runs that package's own tests, not these. This prints each `package.json` whose `scripts` differ from the branch point, committed or not:

```bash
FORK=$(git merge-base "$DIFF_BASE" HEAD)
for f in $(git diff --name-only "$FORK" -- 'package.json' '*/package.json'); do
  [ "$(git show "$FORK:$f" 2>/dev/null | jq -S .scripts)" = "$(jq -S .scripts "$f" 2>/dev/null)" ] || echo "scripts changed: $f"
done
```

**Write the missing tests the review reports**, on this branch, before Step 6, for the files the branch changes — a coverage gap is the cheapest finding there is, and none is filed (`wiki/conventions/review-findings.md`). Dispatch them to a `mechanic` when the review spells out the cases, to an `implementer` when it does not, one code-writing agent at a time. A `T-S` suggestion you decline is a line in the report with the reason. Then re-run the gates the new tests touch.

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

**Unless Step 4 sized the diff `trivial` or `trivial-tests`** — then dispatch no agent. The Performance, Security, State and Design rows of `## Test plan` read `inline — trivial diff`, each with one sentence of your own verdict, and you go to Step 7.

**Unless Step 4 put the branch on the light tier** — then dispatch no agent either: its one pass has run. The Security, and any State or Design, rows name that pass; the Performance row reads `not run — light tier, complexity <n>`, with one sentence of your own verdict. Skip the agent list below and go on from **Write each reviewer's result into the report**: the pass's findings are recorded, its `## For the tracker` entries numbered, and every finding fixed as any reviewer's are.

Otherwise run the **`reviewer`** agents below **in parallel** (one after the other on a large diff, see below) using the Agent tool, as Step 4 describes: Agents 1 and 2 on every `full` verdict, Agent 3 as well when the verdict carries `-state`, and Agent 4 as well when it carries `-design`. A review the verdict does not call for gets its `## Test plan` row as `not needed — review-scope printed <verdict>`, with one sentence of your own: why nothing the diff writes is a state, or why nothing it changes draws a screen.
Open each dispatch prompt with `TASK-BRANCH: <branch>` on its own line, for
the same reason as Step 4's — the collector reads it back out to attribute
the reviewer's spend to this branch's card. Tell each that it is **not** alone
in the worktree, so it builds nothing; a number it needs from a build is yours
to measure afterwards:

**Agent 1 — Performance review** (`reviewer` agent):
Invoke the `review-performance` skill (`.claude/skills/review-performance/SKILL.md`) and execute its instructions, passing the list of affected workspaces and the branch name as context.

**Agent 2 — Security review** (`reviewer` agent):
Invoke the `review-security` skill (`.claude/skills/review-security/SKILL.md`) and execute its instructions, passing the list of affected workspaces and the branch name as context. **This is the full tier's security review: pass `effort: xhigh` on this Agent call** (the owner's instruction; the definition's `high` covers Agents 1, 3 and 4). Agents 1, 3 and 4 pass no effort.

**Agent 3 — State review** (`reviewer` agent), on a `-state` verdict only:
Invoke the `review-state` skill (`.claude/skills/review-state/SKILL.md`) and execute its instructions, passing the list of affected workspaces and the branch name as context. It lists every writer of each state the diff writes across the whole repository, so it reads files outside the diff; that is its job, not scope creep.

**Agent 4 — Design review** (`reviewer` agent), on a `-design` verdict only:
Invoke the `review-design` skill (`.claude/skills/review-design/SKILL.md`) and execute its instructions, passing the list of affected workspaces and the branch name as context. Not being alone, it starts no dev server: it measures contrast from token values where it can, and lists every check it could not run as `unmeasured` in its `## Measurements`, with the method. **Run those checks yourself once every reviewer has returned**, rendered as its Step 5 describes, in this worktree with nothing else building in it; a check that fails is that review's finding, taking the tier its finding format gives.

Wait for every agent you started to complete, and collect or stop each before this run returns, as Step 4 says. Present every report to the user in full, using the finding IDs from each review (e.g. S-H1, P-W2, G-M1, U-H1) so they can be referred to in discussion, in the report and in the issues Step 7 files. The PR is public and never carries an `S-`, `P-` or `C-` ID; `write-pr` says what it carries instead. A `G-` or `U-` ID names a correctness or design defect and may appear there.

**Write each reviewer's result into the report as it returns**, not when every one has returned: one line per finding under `## Reviews`, with its ID, severity and a `pending` disposition. Update the disposition to its fix commit or issue when that exists, and do it before the first fix commit.

**The state and design reviews' `## For the tracker` entries get their IDs last.** Each is a security, performance or compliance defect one of them found, written with no ID because a `G-` or `U-` ID is public. Its `## Reviews` line goes in as it returns, reading `ID pending` with the lens and tier it names. Once every Step 6 reviewer has returned, drop any entry the owning lens's own report already holds (the same writer and the same defect; note the duplicate on the line), and give each one left the next free number in that lens's tier after its report's own: an `S-H` entry after a security report whose last High was `S-H2` becomes `S-H3`. From then on it is that lens's finding, and Step 7 files it in the tracker like any other.

**A reviewer that stops on a usage limit is resumed, not dispatched afresh.** Once the limit resets, `SendMessage` it to carry on, naming the report file it keeps filling: `SECURITY-REVIEW.md`, `PERFORMANCE-REVIEW.md`, `STATE-REVIEW.md` or `DESIGN-REVIEW.md` here, and `TEST-REVIEW.md` or `DOCS-REVIEW.md` for Step 4. The findings it wrote before the limit are already in that file. A report with no closing `**Review complete.**` line is a partial review, not a finished one, and the resumed reviewer finishes it. A fresh dispatch would repeat that work and make a second copy of it. This covers a reviewer that stops while the run goes on; if the run itself must end, Step 4's rule applies.

**On a large diff, one with many changed files or several stacked commits, stagger the reviewers.** Start one, and each next one only after the one before it has returned. Reviewers started together reach a session limit together, and each one that stops then needs resuming.

### Fix what the reviews found

**The reviews' findings are this run's work, not its paperwork.** The full rule
is `wiki/conventions/review-findings.md` §Fix findings; do not file them. Its
working parts:

- **Everything in scope is fixed on this branch**, at every severity: the files
  the branch changes, their tests and docs, and every finding in those files.
- **An issue is left open only for one of three**, named in the report: out of
  scope for the feature; unrelated and found mid-task (including a finding in
  a file the branch does not change); or a larger piece of work — rated 5 or
  more, or needing the owner's decision or access the session cannot have.
- **What is small in the first two goes on one follow-up pull request**, one
  commit per fix, after this one is open: dispatch a subagent whose prompt
  opens `TASK-BRANCH: <follow-up branch>` to cut it, fix and run this skill.
  Name that branch, its commits and its title by area or tracker number, never
  by a defect (`new-feat` Step 0). Run from a follow-up, this step opens no
  further follow-up: what its reviews find out of its scope becomes an issue.
- `info` findings are filed and closed (Step 7); nits and `T-S` suggestions are
  fixed or noted in the report. "Low", "pre-existing", "the diff would grow"
  and "the reviews ran late" never leave something in scope open.
- **More than two issues left open that no open pull request will close means
  something in scope was filed**: put the list to the user before filing a
  third; with no user, fix the in-scope ones and keep only what fits the three.

**A `critical` or `high` finding is never left open**, whichever of the three
it falls in: fix it here, or on the follow-up pull request opened now and
linked before this one merges. Filing it and continuing is not an option, and
`needs:decision` does not release it: one whose fix is the owner's choice
blocks the merge until the owner accepts the risk in writing on its tracker
issue. Put that choice to the owner before the pull request opens, and open it
only once they have answered there: a public draft waiting on the answer would
tell every reader the branch carries an unfixed `critical` or `high`. With no
user, fix every `critical` and `high` yourself. A filed-and-open
`high` is a live unpatched defect whose location is now written down; the issue
is an attack map with a timer on it. Severity comes from the tier letter in the
finding ID, assigned by the review before anyone knows what fixing it costs.
Re-rating it afterwards to make it deferrable is the failure mode this rule
exists to prevent — the same contamination as re-rating an issue's complexity
once its token cost is on screen.

Dispatch the fixes as Step 4 does — `mechanic` when the finding spells out the
fix, `implementer` when it needs a design, one code-writing agent in the
worktree at a time; a fix that adds an export or a route writes its tests in
the same dispatch. Then commit (Step 3), re-run the gates the fixes touched —
Step 4's build and tests, not its review agent — and go to Step 7. **The
reviews run once per branch**: Steps 4 and 6 do not dispatch again after a fix
round. Tell the user what you are fixing and where; ask only about a finding
whose fix is the owner's choice. A run that cannot fix — no tooling, no
network — says so plainly, names every unfixed `critical` and `high` as
blocking, and does not report the branch ready.

---

## Step 7 — File the findings as issues

Work is tracked in GitHub Issues, not in a markdown checklist. Two repos:

| Kind of item                          | Repo                                |
| ------------------------------------- | ----------------------------------- |
| Review findings — `S-*`, `P-*`, `C-*` | **`englishstreetventures/osn-tracker`** (private) |
| State findings — `G-*`                | **`englishstreetventures/osn`** (public)          |
| Design findings — `U-*`               | **`englishstreetventures/osn`** (public)          |
| Planned work, features, bugs          | **`englishstreetventures/osn`** (public)          |

`englishstreetventures/osn` is public. A security, performance or compliance finding names an unpatched route, so filing one there publishes it. **Route by kind, not by severity** — an `S-`, `P-`, or `C-` ID always goes to the tracker, however minor it looks, and that includes one Step 6 gave to a state or design review's `## For the tracker` entry.

**A `G-` finding is a correctness defect and is filed only when it stays open** — one of Step 6's three, or one in scope this run could not finish, so it keeps an owner — or when the follow-up pull request fixes it, so that pull request closes it. One this branch fixes gets no issue: the public pull request and its commit are its record. Its issue is `--type Bug`, with its ID leading the title, `product:`, `severity:` from its tier letter (`C` → `critical`, `H` → `high`, `M` → `medium`, `L` → `low`), and `area:schema` when the fix is a migration; the body is the four fields, written with `write-issue`. **A `U-` finding is filed the same way**, on the same terms, with no `area:` label. The rest of this step's filing rules are for the tracker.

Auditing a defect class — when a finding is an instance of a class, enumerate the *shapes* the defect can take rather than re-grepping the first form you found. Recipe and the D1 bind-cap case study: `references/auditing-defect-classes.md`.

### New findings from Step 6

One tracker issue per `S-`, `P-` or `C-` finding, so that its record stays private and the public PR body can carry it as a bare reference:

- each finding left open as one of Step 6's three — which one goes in the body's **Rationale**;
- each finding in scope that this run did not manage to fix — the fix failed, the budget ran out, the tooling could not run — so it keeps an owner; the report names it as unfinished, not as one of the three;
- each `info` finding, filed and closed at once as not planned, so the tracker keeps its record without it counting as open — `write-issue` skips the rating and the board for an issue closed at filing;
- each finding the follow-up pull request fixes, so that pull request closes it;
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

Defer only what Step 6 lets stay open: out of scope for the feature, unrelated
and found mid-task, or a larger piece of work. A rule left at `warn` or a
workaround standing in for the real fix, in code this feature changes, is in
scope and is finished here. What is deferred gets an issue, and the code carries the link and nothing more
(`// Bounded until englishstreetventures/osn#412 lands.`). A comment that explains the deferral
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
`Closes englishstreetventures/osn-tracker#<n>` lines (`write-pr`), and only
there — an issue this run filed and the branch fixed is never also listed as
raised against the branch, since that reads as work the merge leaves behind. A fixed finding that
predates the branch already has an issue — find it by ID, since the ID leads the
title. Planned work this branch completes goes in the same list, as `Closes #N`
from the public repo. **Never delete an issue**; close it.

`references/workflow-steps.md` carries the rest: the `gh issue list` searches,
the Up Next promotion, and the docs pass — what to check in `AGENTS.md` and the
wiki, and how to verify the wikilinks you wrote resolve.

Report the issues opened, which of them stay open and which of the three each is,
the follow-up pull requests, and the issue numbers this branch closes — Step 8
needs them all.

## Step 8 — Write the PR body

**Do this even when you cannot push.** The body is the deliverable; opening the pull request is only how it is delivered. Write it to the file whichever way the run ends — no network, no `gh`, failing gates, nothing committed.

Invoke the **`write-pr`** skill and follow it. It owns the title and the body: what each of the six sections holds, the impact that leads the body, the `Closes` and `Part of` lines, owner actions, the test plan, and the checks to run before sending. Derive both from the branch's commit history (`git log "$DIFF_BASE"..HEAD --oneline`) and everything this run established.

The skeleton is already on disk from the top of this file. Fill it in — do not write a second body beside it.

One rule from `write-pr` is repeated here because a public body that breaks it cannot be taken back: a tracker issue appears only as a bare reference — `Closes englishstreetventures/osn-tracker#<n>` for one this branch fixes — never with its finding ID, its title, or a word about the defect.

**The test plan carries a row for every gate Step 4 ran, the three lint gates included,** so a reader can see that `lint`, `fmt:check` and the warning ceiling were each run. **Every test-plan row is filled in from a command you ran in this worktree, in this run.** A gate you did not run is `NOT RUN` with the reason, and a run where nothing could execute is a table of `NOT RUN` rows — a correct and complete test plan. Never write a tick, a "passes", or a pass count you did not watch appear: an invented green gate is the one failure in this document a reviewer cannot detect.

### The session metrics are not this step's job

`retro` writes and commits the card in Step 9, before the push, and Step 9
appends its `<details>` block to this file. Leave the body without it until
then — no placeholder, and do not run the collector here: a card on disk with
no issue on it is the one thing that makes `retro`'s job harder.

### Check the body before you finish

```bash
grep -c '^## \(Impact\|Summary\|Workspaces affected\|Issues\|Decisions\|Test plan\)$' <body-file>
grep -c '^## ' <body-file>
```

Both must print `6`. A first count under 6 means a section is missing, renamed, or demoted to `###`. A second count above 6 means you added a top-level section of your own — the most common one is a place to park notes about gates that could not run, and those belong in the report file instead. Custom top-level headings are not allowed: a change-specific title goes in the PR title and in `## Summary`, never as a `##` of its own.

### Check the wording before the push

When the body closes a tracker issue, the before-and-after wording check runs over the changeset, the wiki changes and the commit messages too, not only the body. A commit message and a changeset are public once pushed. The pattern is `write-pr` Step 6's, verbatim; change both together.

```bash
PAT='down from|no longer|previously|used to|→|->|was exposed'
if grep -q 'osn-tracker#' PR-BODY.md; then
  { git diff -U0 "$DIFF_BASE" -- .changeset wiki | grep '^+' | grep -v '^+++'
    git log --format=%B "$DIFF_BASE"..HEAD; } | grep -iE "$PAT"
fi
```

It prints every line that matches. **The push waits until it prints nothing.** Reword each line in its own file, amend or rewrite the commit message while the branch is unpushed, and run the command again.

---

## Step 9 — Push and open the PR

### Draft or ready

**A pull request that is not ready and waits on the owner opens as a draft.**
Decide before it opens, from what this run already knows. It waits on the owner
while any of these is open:

- **A decision about this change**: a question its body puts to the owner; a
  choice its review found that only the owner can make and that this change
  depends on, unless it is a security, performance or compliance finding
  (below); or an open `needs:decision` proposal on the issue it closes, when
  the answer changes what merges. Read the question, not the label: a label can
  outlive its answer, and an epic's open question rarely holds one of its
  children. Whether the owner has answered is
  `wiki/conventions/review-findings.md` §What counts as the owner's answer.
- **An approval only the owner can give**: the `production` Environment
  approval on a release it needs first, an audit-ignore entry they have to
  accept, or the owner's approval of a frontend stack. Every pull request in
  one waits on it (`wiki/conventions/stacked-prs.md` §Frontend: one component
  per pull request). A component's line names the feature pull request being
  marked ready; the owner leaves components as drafts, and the session that
  merges the stack marks them ready.
- **A "not ready" only the owner can settle**, named in this run's report or in
  the report of the session that built the branch.

Otherwise it opens ready for review. None of these makes it a draft: an issue
raised against the branch and left open as one of Step 6's three, since the
merge does not wait on it; an `— owner's call` default the run took, which the
owner can overrule in review; a file `.github/CODEOWNERS` names; a red check
`main` caused (`review-pr` Step 4); the order a stack merges in. Unfinished
work in scope is not a reason either. Step 6 fixes it before the pull request
opens, and a draft is never a place to leave it. A security, performance or
compliance finding whose fix is the owner's choice and that this change waits
on, at any severity, does not open at all until the owner answers on its
tracker issue (Step 6 for a `critical` or `high`).

A draft says why, still runs CI on every push, and must not be merged until the
owner answers:

- **The body**: a `**Do not merge until**` line at the end of `## Impact`
  naming what the owner has to answer or approve, as `write-pr` §Owner actions
  writes it. It names a public issue or a `###` decision, never a tracker
  issue.
- **Opening it**: add `-F draft=true` to `write-pr` Step 6's REST command,
  which also says how to convert one already open. A remote session, which has
  no GraphQL, decides before it opens.
- **The question**: put it where the owner reads it, as a `needs:decision`
  proposal on the issue the pull request closes (`write-issue`). An approval
  has no question: no proposal, no label.
- **Leaving draft**: the owner marks it ready, and nobody else; no session
  marks ready a pull request whose body carries a `**Do not merge until**`
  line. The one exception is a frontend stack's component pull request, which
  the merging session marks ready once the owner has marked the feature pull
  request ready and the line is edited out. A session that applies the owner's answer pushes it, rewords the line
  to say the answer is applied and the owner has only to mark it ready, and
  tells the owner. The session that merges it, once the owner has, removes the
  line. GitHub will not merge a draft.

### The card goes first

Before the push, invoke **`retro`** (`.claude/skills/retro/SKILL.md`) with the
branch name, or `retro-v2` when the session is short of budget. With no pull
request yet, it writes the session-metrics card, commits it with any wiki fix
it makes, and leaves the card's `<details>` block in
`${TMPDIR:-/tmp}/card-<branch-slug>.md` without pushing. Append that block to
the body file, last, unless it is there already
(`grep -c '^<details><summary>Session metrics' PR-BODY.md`). The push below
then carries the card, and the pull request's first CI run is its only one: a
card committed after the pull request opens is a second push and a second run.
When the body closes a tracker issue, run Step 8's wording check again after
`retro`'s commits, since they are public once pushed.

This is not optional tidying. The card is the only durable record of what the
work cost — `~/.claude/projects` is local, unversioned, and dies with a remote
container. A branch whose retro never ran leaves the `SessionEnd` hook to write
a card with no issue and no rating, which lands in the corpus looking complete
and answering nothing. With no network or no `gh`, invoke it anyway: the card
is written from the branch and the transcripts.

```bash
git push -u origin HEAD
```

Then open it with `write-pr` Step 6's REST command, passing `$BASE` as `base` —
the REST call has no default and reads no git config, so a stacked branch that
omits it is refused rather than opened — with `-F draft=true` when it waits on
the owner, and run that step's check that GitHub registered every `Closes` line.

With no network or no `gh`, record that the PR was not opened, name the base it
should target, and leave the body file in place. Still run the local half of
the merge check below, on the refs on disk. That is a complete run.

Confirming the base took, and registering a stack when `$BASE` is not `main`,
are in `references/workflow-steps.md`.

### Can it merge

Green checks say nothing about conflicts, and `main` keeps moving while a pull
request waits. Before the report calls the branch ready, check both views.

**Locally, with no API call.** Fetch with explicit refspecs, since a bare clone
maps no remote-tracking refs and a plain fetch leaves them stale:

```bash
git fetch origin "+refs/heads/${BASE}:refs/remotes/origin/${BASE}" \
  "+refs/heads/$(git branch --show-current):refs/remotes/origin/$(git branch --show-current)"
git merge-tree --write-tree "refs/remotes/origin/${BASE}" HEAD; echo "exit $?"
```

Read the exit status, not the text: `0` merges cleanly, `1` conflicts and lists
the files, anything else is an error (a bad ref, say), which proves nothing.
For a stack, run it once more with `refs/remotes/origin/main` and the top
branch: each pull request is merged against its parent, so only this shows
`main` conflicting with a higher layer. With no network, run it on the refs
already on disk and say so.

**GitHub's view**, once the pull request exists:

```bash
gh api repos/englishstreetventures/osn/pulls/<n> --jq '[.mergeable, .mergeable_state]'
```

`.mergeable` decides: `false` is a conflict. `null` means GitHub has not worked
it out yet; read it once more, and if it is still `null`, the local result
stands and the report says GitHub's answer was not ready. Never poll it in a
loop: each read spends the REST budget every agent on the account shares. Of
the `mergeable_state` values, `dirty` is a conflict; `behind` means the base
moved and the branch needs a rebase; `blocked` means a required check or review
is pending or has failed, so read the checks; `draft`, `unstable`, `clean` and
`has_hooks` do not stop this step.

**A conflict or `behind` means the run is not done.** Report it with the
conflicting files; this step does not rebase or force-push on its own account.
Under `orchestrate`, the orchestrator dispatches an `implementer` to resolve it
(its `DIRTY` or `BEHIND` rule). Run on its own, the session rebases only its own
branch, onto its base: `origin/main` for a bottom or single pull request, its
parent branch for a stacked one (`wiki/conventions/stacked-prs.md` §Carrying a
change up). It never rewrites a lower layer under a session still building it.
Record the head before the fetch and push with the lease pinned to it,
`--force-with-lease=<branch>:<recorded head> --force-if-includes`. Then run
`bun install --frozen-lockfile`, re-run the build and tests the resolution
touched, and add a `## Test plan` row naming the new commit and saying its tree
postdates the reviews. Check again before reporting.

Report the PR number, its base branch, whether it can merge (each view's
answer), whether it opened as a draft and what it waits on, whether the stack
is registered, the issues it closes, and any close it could not make — a
tracker line the classifier refused, or a stacked PR's closes — so the owner
can make it by hand.

