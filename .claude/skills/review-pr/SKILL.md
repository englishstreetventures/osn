---
name: review-pr
description: Use when asked to review and fix an open pull request this session did not write — one another tool such as Codex opened, or another session left — and bring it to merge-ready on its own branch. Covers finding and reusing the branch's existing worktree, rebasing it and regenerating bun.lock with evidence instead of merging it, running prep-pr's review lenses on someone else's work, telling a red check main caused from one the branch caused, fixing every finding on the branch, and rewriting the body with write-pr.
---

Review and fix pull request `$ARGUMENTS`. If it is empty, ask for the number.

A pull request written outside this pipeline skipped `prep-pr` and `write-pr`.
It arrives with whatever its author believed: a test plan saying lint passed
when CI says otherwise, a wiki page it made stale, a body in the wrong shape.
Nothing in it counts until this run has checked it.

## What this run must produce

1. **The branch, merge-ready, on its own branch** — rebased when it is behind or
   conflicts, every gate re-run by this run, every finding fixed on the branch
   or filed. In the branch's existing worktree; never a second one.
2. **The body rewritten with `write-pr`**: every sentence true of the head
   commit, every test-plan row from a command this run ran.
3. **The report** — `prep-pr`'s report file (`PREP-PR-REPORT.md` unless the task
   names another) with three sections of this skill's own: the worktree and
   its state, the lockfile evidence when Step 2 ran, and each red check with
   whose it is.
4. **Nothing left running.** Every reviewer this run started has reported or
   been stopped, and every wait has ended.

Every subagent this skill dispatches gets `TASK-BRANCH: <the PR's branch>` as
the first line of its prompt, so its spend lands on that branch's card
(`tools/pr-metrics/index.ts`, `resolveDispatchBranch`).

The commands in Steps 2 and 3 are bash. The local shell is fish, so run them
inside `bash -c '…'` or from a script file.

## Step 0 — Read the pull request

```bash
gh api repos/englishstreetventures/osn/pulls/<n> \
  --jq '{state, draft, head: .head.ref, head_repo: .head.repo.full_name, base: .base.ref, sha: .head.sha, mergeable_state}'
```

- Not `open` → stop and say so.
- `head_repo` is not `englishstreetventures/osn` → stop. A fork's branch cannot
  be pushed from here; report what you would change instead.
- `base` is not `main` → the branch is stacked; `prep-pr` Step 0 handles it.
- The issues it closes: `write-pr` Step 6's `closingIssuesReferences` query.
  Each issue's **Done when** is the contract the branch is reviewed against. No
  issue at all → `write-pr` §Issues rule 1.
- **The body is a list of claims, not a record.** Note every gate it says
  passed, every review it says ran and every file it says changed. Each is
  checked by Steps 3 to 5; none of them goes into the new body unchecked.

**The claim.** The open pull request already holds its issue in
`next-batch` §Claim's terms, and the request to review it is what lets you take
it over. Leave the card in, or move it to, In Review. If the issue is In
Progress and you did not put it there, another session may be working on it:
ask before touching the branch.

## Step 1 — Use the branch's worktree; never make a second

Fetch first, every time. A bare clone maps no remote-tracking refs, so without
the explicit refspec `origin/<branch>` is missing or stale and every check below
answers about the wrong commit.

```bash
git -C /Users/ac/.work/osn.git fetch origin \
  "+refs/heads/<branch>:refs/remotes/origin/<branch>" "+refs/heads/main:refs/remotes/origin/main"
git -C /Users/ac/.work/osn.git worktree list | grep -F "[<branch>]"
```

**One line** — that path is the worktree. Check it before anything else:

```bash
git -C <dir> status --porcelain                    # must print nothing
git -C <dir> log --oneline origin/<branch>..HEAD   # must print nothing
git -C <dir> merge --ff-only origin/<branch>       # brings in commits pushed from elsewhere
```

Uncommitted files, or commits the pull request does not have, are someone
else's work in progress — the other tool's, another session's, the owner's.
Stop and report them. Do not stash, commit, reset or build over them.
`merge --ff-only` works where `git pull` does not: a worktree another tool made
may have no upstream configured. A worktree with no `node_modules` gets
`bun install --frozen-lockfile`.

**A line ending `prunable`** — the directory is gone. Run
`git -C /Users/ac/.work/osn.git worktree prune`, then treat it as none.

**No line** — make one, and note that this run owns it:

```bash
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> <branch>                      # a local branch exists
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> -b <branch> origin/<branch>   # it does not
(cd /Users/ac/.work/osn.git/<dir> && bun install --frozen-lockfile)
```

`<dir>` is the branch name without its prefix. Every later step runs in that
worktree. Never run `git worktree add` for a branch that already has one — git
refuses with `fatal: '<branch>' is already used by worktree at '<path>'` — never
`git checkout <branch>` inside another worktree, and never cut a new branch from
the pull request to get round either: its commits would reach no pull request.

After the merge, remove the worktree only if this run made it. One another tool
made stays where it is, and the report names it.

On the remote environment there is no bare repository: `git fetch origin <branch>`,
then `git checkout -B <branch> origin/<branch>` in the checkout.

## Step 2 — Rebase, and regenerate `bun.lock`

Rebase when `mergeable_state` is `dirty` or `behind`. Otherwise go to Step 3.
Record the two commits the evidence below needs, and write both into the
report:

```bash
ORIG=$(git rev-parse HEAD)
MB=$(git merge-base origin/main HEAD)
git rebase origin/main
```

Source conflicts: keep both sides' intent. Sibling pull requests that merged
first are usually additive; changeset and version churn from the release
workflow takes main's state. Run the touched packages' tests afterwards.

**`bun.lock` is never merged — not by hand, not by git.** Two lockfiles merged as
text make a file neither side resolved, and a bare `bun install` drops every
entry for a platform this machine is not, which CI needs. Regenerate it
whenever both sides changed it since `MB`, whether or not git reported a
conflict:

```bash
git diff --quiet "$MB" origin/main -- bun.lock || echo "main changed bun.lock"
git diff --quiet "$MB" "$ORIG" -- bun.lock || echo "the branch changed bun.lock"
```

Both lines print → regenerate. At each rebase stop where `bun.lock` conflicts,
resolve the other files, then take main's lockfile and go on:

```bash
git checkout origin/main -- bun.lock && git add bun.lock && git rebase --continue
```

When the rebase has finished, regenerate once, in a commit of its own:

1. **List the branch's own dependency changes**, for each manifest it touched:

   ```bash
   git diff --name-only "$MB" "$ORIG" -- package.json '*/package.json' '*/*/package.json'
   deps() { git show "$1:$2" | jq -S '{dependencies, devDependencies, peerDependencies, optionalDependencies, overrides}'; }
   diff <(deps "$MB" <path>) <(deps "$ORIG" <path>)
   ```

2. **Start from main's lockfile**: `git checkout origin/main -- bun.lock`.
3. **Re-apply each change exactly as the branch declared it:**

   | The branch's change | Command |
   |---|---|
   | A bare version, `"4.0.3"` | `bun add '<pkg>@4.0.3' --exact --cwd <dir>` |
   | A range, `"^1.4.30"` | `bun add '<pkg>@^1.4.30' --cwd <dir>` |
   | In `devDependencies`, `optionalDependencies` or `peerDependencies` | the same, plus `--dev`, `--optional` or `--peer` |
   | A removal | `bun remove <pkg> --cwd <dir>` |
   | An `overrides` entry, or anything else `bun add` cannot express | Edit the manifest and splice the lockfile entry by hand, as `wiki/conventions/contributing.md` says |
   | A new workspace, a `patchedDependencies` change, or a version `minimumReleaseAge` refuses | Stop and report: this recipe does not cover it |

4. **Prove only the branch's packages moved.** The resolved set of a lockfile is
   every `name@version` in its `packages` block:

   ```bash
   lockset() { grep -oE '^    "[^"]+": \["[^"]+"' | sed -E 's/^    "[^"]+": \["//; s/"$//' | sort -u; }
   git show origin/main:bun.lock | lockset > /tmp/pr-<n>-main.txt
   lockset < bun.lock                 > /tmp/pr-<n>-new.txt
   git show "$MB":bun.lock   | lockset > /tmp/pr-<n>-mb.txt
   git show "$ORIG":bun.lock | lockset > /tmp/pr-<n>-orig.txt
   comm -3 /tmp/pr-<n>-main.txt /tmp/pr-<n>-new.txt   # this regeneration against main
   comm -3 /tmp/pr-<n>-mb.txt /tmp/pr-<n>-orig.txt    # the branch against its own base
   ```

   Every line of the first list is one of the branch's packages, or one that
   `bun why <name>` traces to one of them. Anything else — a platform binary
   gone, a package main bumped now rolled back — means the lockfile is wrong:
   start this step again. A package in the second list and missing from the
   first was not re-applied.

   Then the manifests, compared as data because `bun add` rewrites the whole
   file: for each one the branch touched,
   `diff <(git show origin/main:<path> | jq -S '{dependencies, devDependencies, peerDependencies, optionalDependencies, overrides}') <(jq -S '{dependencies, devDependencies, peerDependencies, optionalDependencies, overrides}' <path>)`
   lists the branch's entries and nothing else. Last,
   `bun install --frozen-lockfile` exits 0.

5. **Commit** the lockfile and manifests with a message naming the packages.
   Put both `comm` outputs and their line counts in the report, and one row in
   the test plan.

## Step 3 — A red check: the branch's, or main's?

Before fixing a red check, find out whose it is. A test that fails on `main`
too is not this branch's to fix, and a flaky one fixed here hides the flake.

```bash
gh pr checks <n> --repo englishstreetventures/osn --json name,bucket,link,workflow
gh run view <run-id> --repo englishstreetventures/osn --log-failed | grep -m 20 -iE 'fail|error|timed out'
```

The run id is in the check's `link`. Name the failing test or step, then look
at `main`:

```bash
gh run list --repo englishstreetventures/osn --branch main --workflow <workflow-file> --limit 5 \
  --json databaseId,headSha,conclusion,createdAt
gh run view <main-run-id> --repo englishstreetventures/osn --log-failed | grep -m 20 -F '<test name>'
git diff --name-only origin/main...HEAD -- <the failing package's directory>
```

| What you find | Whose it is | What to do |
|---|---|---|
| The same test failed in a recent run on `main` | main's | Find its issue, or open one with `write-issue`. Do not fix it on this branch. The test-plan row names main's run. Whether to merge over it is the owner's decision; never `gh pr merge --admin` |
| It passes on `main` and the branch changes nothing in that package | probably a flake | `gh run rerun <run-id> --failed`, once. Green: say so, and open an issue for the flake if none exists. Red again: treat it as the branch's |
| The branch changes that package, or the test fails here and passes on `origin/main` | the branch's | Step 5 fixes it |

Run the failing test in this worktree as well. Passing here while failing in CI
is evidence of a flake under load, not proof of one.

## Step 4 — Run the review lenses on work you did not write

Invoke `prep-pr` and run its Steps 0 to 7 on this branch, in this worktree, with
two differences:

- **The pull request's body is not the task.** `prep-pr` skips its reviews when
  the task says they have already run. A body saying reviews ran, or gates
  passed, is one of the claims under review: run them.
- **One more `reviewer`**: the whole branch against the Done when of each issue
  it closes. It runs beside `prep-pr` Step 6's two, so tell it it is not alone in
  the worktree and builds nothing.

Collect or stop every reviewer before this run returns. Then hold each claim
from Step 0 against what the gates and reviews found: a claim that is untrue
is a finding too, fixed when Step 6 rewrites the body.

## Step 5 — Fix every finding on this branch

Fix the pull request's findings here, on the rule `orchestrate` Step 4 sets:
Critical, High and Medium at minimum, Low and Info when cheap, and Critical and
High never deferred (`prep-pr` Step 6). Missing tests from `review-tests` get
written. A finding about code this pull request does not touch gets an issue
(`prep-pr` Step 7), not a fix here.

One code-writing agent in this worktree at a time. Commit each fix, re-run the
gates it touched, and note the commit each gate ran on.

## Step 6 — Body, push, and CI

Start from the live body, since the API replaces the whole of it:

```bash
gh api repos/englishstreetventures/osn/pulls/<n> --jq .body > PR-BODY.md
```

Invoke `write-pr` and rewrite it into the five sections. Keep nothing from the
old body that this run did not confirm; the test plan is this run's rows only,
each with its commit. Fix the title too when it breaks `write-pr` Step 3.

```bash
git push --force-with-lease origin <branch>   # after a rebase; plain `git push origin <branch>` otherwise
gh api -X PATCH repos/englishstreetventures/osn/pulls/<n> -F body=@PR-BODY.md --jq .html_url
```

The explicit `origin <branch>` makes the lease compare against the
`origin/<branch>` Step 1 fetched, and works in a worktree with no upstream.
Then run `write-pr` Step 6's check that the closes registered.

Wait for CI with an end: `bash .claude/skills/orchestrate/references/wait-pr.sh <n> 30`,
run in the background. It stops on merged, closed, conflicting, a failed check,
every check finished, or 30 minutes. A red check goes back to Step 3.

Then `retro` on the branch.

**Under `orchestrate`**, stop after the push and the body edit, and report:
the orchestrator's Step 5 runs `retro`, waits on CI with its shepherd and
merges. A second wait from here would watch the same checks twice.

## Stop and hand back when

- the worktree holds uncommitted files or unpushed commits (Step 1)
- the head is on a fork (Step 0)
- the lockfile needs a change the recipe does not cover (Step 2)
- a fix needs a product or scope decision — return
  `NEEDS INPUT: <question> + options + recommendation`

## Traps

| Trap | Instead |
|---|---|
| `git worktree add` for the pull request's branch | `git worktree list \| grep -F "[<branch>]"` first; git refuses a second worktree for a branch anyway |
| Stashing or resetting a dirty worktree to start clean | Stop and report: it is someone else's work |
| Taking one side of `bun.lock`, or letting git merge it | Main's lockfile plus `bun add` for each of the branch's changes, then the evidence in Step 2 |
| A bare `bun install` to "fix" the lockfile | It drops other platforms' entries; `bun install --frozen-lockfile` only proves the file |
| Copying the old body's test plan | Re-run each gate; a row this run did not watch is `NOT RUN` |
| Fixing a test that also fails on `main` | Step 3: its own issue and its own pull request |
| A CI wait with no end | `wait-pr.sh`, which stops on failure and at a deadline |
| Removing the worktree after the merge | Only when this run made it |
