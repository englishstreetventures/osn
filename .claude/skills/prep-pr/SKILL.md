---
name: prep-pr
description: Use when preparing the current branch for a pull request — resolving the base branch, checking changesets, running builds and reviews, filing findings as issues, and opening the PR with the mandatory five-section body.
---

Prepare the current branch for a pull request.

## What this run must produce

Two files, always, whatever else fails:

1. A **PR body** with exactly five `##` sections. The template is in Step 8.
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
step replaces a `None`, or inserts text under a heading that already exists.
Do not compose the body in your head and write it out whole at Step 8 — a
single write to `PR-BODY.md` discards the shape this step just established, and
that is the one way this run fails outright however good the preparation was.
If you find yourself about to write the whole file, you have lost the skeleton:
read it back first and edit what is there.

**A decision is a `###`, never a `##`.** The Decisions template below uses one
`###` heading per decision, inside `## Decisions`. Promoting one to `##` adds a
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
git fetch origin "$BASE"
echo "base: $BASE"
```

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

Use `$BASE` in every `git diff` below and as `--base` in Step 9.

---

## Step 1 — Identify changed workspaces

```bash
git diff --name-only "$BASE"...HEAD
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

```bash
git diff --name-only "$BASE"...HEAD -- .changeset/   # minus config.json, README.md
bash scripts/validate-changesets.sh
```

`validate-changesets.sh` is the authority and needs no network and no install —
shell and `jq`. It fails on exactly the two mistakes CI catches: a package name
that is in no workspace, and one changeset mixing an ignored (version-less)
package with a versioned one. Your own reading of the frontmatter is the
cross-check, not the verdict.

**A name that does not match a `package.json` `name` field fails CI** at
`changeset version` with "package not in workspace" — `osn-api` where the
package is `@osn/api`. Verify each with `jq -r .name <workspace>/package.json`.

If no changeset exists: run `scripts/changeset-required.sh` first. If it says
`skip`, none is needed — say so and do not create an empty one. Otherwise draft
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

Invoke the `review-tests` skill (`.claude/skills/review-tests/SKILL.md`) as an Agent subagent, passing the list of affected workspace paths as arguments.

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

## Step 6 — Parallel reviews

**Unless the task says these reviews have already run** — then record what it says they found, note it under `## Decisions`, and go to Step 7.

Otherwise run the following two agents **in parallel** using the Agent tool:

**Agent 1 — Performance review** (general-purpose agent):
Invoke the `review-performance` skill (`.claude/skills/review-performance/SKILL.md`) and execute its instructions, passing the list of affected workspaces and the branch name as context.

**Agent 2 — Security review** (general-purpose agent):
Invoke the `review-security` skill (`.claude/skills/review-security/SKILL.md`) and execute its instructions, passing the list of affected workspaces and the branch name as context.

Wait for both agents to complete. Present both reports to the user in full, using the finding IDs from each review (e.g. S-H1, P-W2) so they can be referenced in the PR description.

Ask the user: "Do you want to address any findings before pushing?" If yes, pause and let the user make changes, then re-run steps 3 and 4 before continuing. With no user, list the findings under `## Decisions` with what you would fix and what you would defer, and continue.

---

## Step 7 — File the findings as issues

Work is tracked in GitHub Issues, not in a markdown checklist. Two repos:

| Kind of item                          | Repo                                |
| ------------------------------------- | ----------------------------------- |
| Review findings — `S-*`, `P-*`, `C-*` | **`xchromo/osn-tracker`** (private) |
| Planned work, features, bugs          | **`xchromo/osn`** (public)          |

`xchromo/osn` is public. A finding names an unpatched route, so filing one there publishes it. **Route by kind, not by severity** — an `S-`, `P-`, or `C-` ID always goes to the tracker, however minor it looks.

Auditing a defect class — when a finding is an instance of a class, enumerate the *shapes* the defect can take rather than re-grepping the first form you found. Recipe and the D1 bind-cap case study: `references/auditing-defect-classes.md`.

### New findings from Step 6

One issue per finding that this branch does **not** fix. Title leads with the finding ID; body keeps the same four fields the PR uses.

**The issue body must stand on its own.** Someone opening it in six months, with no branch checked out and no wiki open, must be able to see what is wrong, where, and what to do. Name the file and line. State the concrete fix. A body that points at a wiki page instead of saying the thing — "see `wiki/todo/api.md`", "tracked in the TODO" — is not an issue, it is a bookmark, and the page it points at moves or dies. Where a wiki page genuinely adds context, name it by **repo path** (`wiki/systems/rate-limiting.md`) and put the fact in the issue anyway; a `[[wikilink]]` does not resolve on GitHub.

A full worked `gh issue create` — flags, four-field body, closing line — is in `references/issue-filing-example.md`.

Labels, exactly one of each:

- `area:` — `security` for `S-*`, `performance` for `P-*`, `compliance` for `C-*`
- `severity:` — from the ID prefix per `wiki/conventions/review-findings.md`: `C` → `critical`, `H`/`W` → `high`, `M` → `medium`, `L` → `low`, `I` → `info`
- `product:` — `osn-core`, `pulse`, `cire`, `zap`, `shared`, or `landing`

`--type`, exactly one — an org-level field the Project groups and filters on, separate from the labels:

- **`Bug`** for an `S-*` or `P-*` finding: something behaves wrongly and wants fixing
- **`Task`** for a `C-*` compliance item, and for any finding filed at `severity:info` — it records an observation and asks for no fix

### The rest of Step 7

Findings this branch **fixes** are closed by the merge, not by an issue you open
and close: put `Closes #N` in the PR body and let it happen. A fixed finding
that predates the branch already has an issue — find it by ID, since the ID
leads the title. Planned work this branch completes goes in the same list, from
the public repo. **Never delete an issue**; close it.

`references/workflow-steps.md` carries the rest: the `gh issue list` searches,
the Up Next promotion, and the docs pass — what to check in `CLAUDE.md` and the
wiki, and how to verify the wikilinks you wrote resolve.

Report the issues opened and the issue numbers this branch closes — Step 8 needs
both.

## Step 8 — Write the PR body

**Do this even when you cannot push.** The body is the deliverable; `gh pr create` is only how it is delivered. Write it to a file whichever way the run ends — no network, no `gh`, failing gates, nothing committed.

Derive the title and body from the branch's commit history (`git log "$BASE"...HEAD --oneline`) and everything that happened during this prep-pr run.

**Title**: short imperative summary of the whole change, under 70 chars.

**Body**: exactly these five sections, in this order. All five are mandatory; a section with nothing in it says "None" rather than being dropped, because an absent section reads as a forgotten one.

The skeleton is already on disk from the top of this file. Fill it in — do not
write a second body beside it.

```markdown
## Summary

<Two or three sentences of prose: what this branch changes and why it was
needed. Not a commit-log restatement — the reviewer can read the commits.
Then bullets for anything the prose could not carry.>

## Workspaces affected

`<pkg>`, `<pkg>`. <Changeset status: which packages it names and at what bump,
or why none is needed.>

## Issues

**Closes**

| Issue | What |
|---|---|
| #<n> | <one-line title> |
| xchromo/osn-tracker#<n> | <finding ID only — e.g. `S-M1`> |

Closes #<n>
Closes xchromo/osn-tracker#<n>

<!-- One plain line per closed issue, under the table and outside it — a table
cell does not trigger GitHub's closing keyword. If this branch closes nothing,
write "This branch closes no issue." and drop the table. -->

**Opened**

| Issue | What |
|---|---|
| xchromo/osn#<n> | <one-line title> |
| xchromo/osn-tracker#<n> | <finding ID only> |

<!-- This PR is public and the tracker is private. A tracker row is the number
and the finding ID and nothing else: no title, no file:line, no word about how
the finding is reached. `xchromo/osn-tracker#412 — S-M1` is the whole entry. -->

## Decisions

### <short title> — `<S-H1 / P-W2 / approach / …>`

- **Issue** — what the problem was.
- **Why** — why it mattered: risk, correctness, or design concern.
- **Solution** — what was done.
- **Rationale** — why this is the right fix, and what was rejected.

### <next decision> — `<ID or "approach">`

…

**Out of scope** — <one line per thing found and deliberately not fixed here.
A line is the issue reference and nothing else: `xchromo/osn-tracker#412 —
S-M1`. Do not describe the finding, name its file or line, or say how it is
reached — see the rule under **Section rules**, which this subsection is the
usual place to break. If there is nothing, the line is "**Out of scope** —
None." — never a missing subsection.>

## Test plan

| Gate | Command | Result |
|---|---|---|
| Type check | `bun run check` | <what happened, or `not run — <reason>`> |
| Tests | `bun test <scope>` | <`<n> pass`, a failure, or `not run — <reason>`> |
| … | … | … |

<Then anything a reviewer must exercise by hand, and anything that stayed
unverified — say so plainly rather than leaving it implied.>
```

**Every row is filled in from a command you ran in this worktree, in this run.**
The Result column takes what the command actually printed. A gate you did not
run is written `not run` with the reason — no package manager, no network, no
dependencies — and a run where nothing could execute is a table of `not run`
rows, which is a correct and complete test plan. Never write a tick, a "passes",
or a pass count you did not watch appear: an invented green gate is the one
failure in this document a reviewer cannot detect.

### Section rules

**Issues.** One row per issue. **"Opened" means issues raised *against this
branch*** — findings from its own review, or work it deliberately split out. An
issue found while auditing another package does not belong in the table however
it was discovered: listing it implies a relationship the PR does not have.
Mention a cross-package audit in one line under **Out of scope**. The plain
`Closes` lines under the table are what actually close anything;
`Closes owner/repo#n` works cross-repo with write access to both, but verify it
closed after the merge.

**Decisions.** One `###` per decision, so each gets an anchor. The heading is
plain English, the ID goes after the em dash in backticks and is omitted where
there is no finding behind it, and the four fields are mandatory and always in
that order. What belongs: every non-trivial design choice, every finding fixed
here, and every finding **dismissed** rather than fixed, with the reasoning in
**Rationale**. What does not: lint fixes, formatting, anything the diff already
says.

**Test plan.** The gates that ran, with their real results, and below the table
anything a reviewer must exercise by hand — including the honest negatives.

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
gh pr create --base "$BASE" --title "<title>" --body-file <path>
```

Pass `--body-file`, never `--body`: a heredoc inside `--body` mangles backticks
and `$` in the prose. Pass `--base` even though `gh` reads
`branch.<current>.gh-merge-base` itself, because a branch created without that
config silently targets `main`.

With no network or no `gh`, record that the PR was not opened, name the base it
should target, and leave the body file in place. That is a complete run.

Confirming the base took, and registering a stack when `$BASE` is not `main`,
are in `references/workflow-steps.md`. Report the PR number, its base branch,
whether the stack is registered, and the issues it closes.
