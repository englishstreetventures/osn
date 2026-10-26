---
name: review-pr
description: Use when asked to review and fix an open pull request this session did not write — one another tool such as Codex opened, or another session left — and bring it to merge-ready on its own branch. Covers finding and reusing the branch's existing worktree, reading what the branch would run before running it, rebasing it and regenerating bun.lock with evidence instead of merging it, running prep-pr's review lenses on someone else's work, telling a red check main caused from one the branch caused, fixing every finding on the branch, and rewriting the body with write-pr.
---

Review and fix pull request `$ARGUMENTS`. If it is empty, ask for the number.

A pull request written outside this pipeline skipped `prep-pr` and `write-pr`.
It arrives with whatever its author believed: a test plan saying lint passed
when CI says otherwise, a wiki page it made stale, a body in the wrong shape.
Nothing in it counts until this run has checked it — and its code has not been
reviewed, so nothing of it runs on this machine until this run has read it.

## What this run must produce

1. **The branch, merge-ready, on its own branch** — rebased when it is behind or
   conflicts, every gate re-run by this run, every finding fixed on the branch
   or filed. In the branch's existing worktree; never a second one.
2. **The body rewritten with `write-pr`**: every sentence true of the head
   commit, every test-plan row from a command this run ran.
3. **The report** — `prep-pr`'s report file (`PREP-PR-REPORT.md` unless the task
   names another) with sections of this skill's own: who wrote the pull request,
   the worktree and its state, what the branch would run and what you read of
   it, the lockfile evidence when Step 3 ran, and each red check with whose it
   is.
4. **Nothing left running.** Every reviewer this run started has reported or
   been stopped, and every wait has ended.

Every subagent this skill dispatches gets `TASK-BRANCH: <the PR's branch>` as
the first line of its prompt, so its spend lands on that branch's card
(`tools/pr-metrics/index.ts`, `resolveDispatchBranch`).

The commands below are bash. The local Bash tool runs zsh, so run them inside
`bash -c '…'` or from a script file, and remember that a shell variable does not
outlive one Bash call: write each commit you will need later into the report,
and pass it on by its value.

## Step 0 — Read the pull request

```bash
gh api repos/englishstreetventures/osn/pulls/<n> \
  --jq '{state, draft, author: .user.login, head: .head.ref, head_repo: .head.repo.full_name, base: .base.ref, sha: .head.sha, mergeable_state}'
gh api repos/englishstreetventures/osn/pulls/<n>/commits \
  --jq '.[] | "\(.sha[0:9]) author \(.commit.author.name) <\(.commit.author.email)> · committer \(.commit.committer.name) · \(.author.login // "no account")"'
```

- Not `open` → stop and say so.
- `head_repo` is not `englishstreetventures/osn` → stop. A fork's branch cannot
  be pushed from here; report what you would change instead.
- The branch name must match `^[A-Za-z0-9._/-]+$` before it goes into any
  command below; git allows `$`, `;`, backticks and brackets in a ref name.
  Anything else → stop and report it. A name starting `origin/`, `refs/`,
  `heads/`, `tags/` or `remotes/` → stop too: checked out here it would shadow
  a ref every later step trusts.
- Record the pull request's author and every commit's author and committer in
  the report. Code from an account or a tool the owner did not name is a
  question for the owner before Step 2 runs any of it.
- `base` is not `main` → the branch is stacked; `prep-pr` Step 0 handles it.
- The issues it closes: `write-pr` Step 6's `closingIssuesReferences` query.
  Each issue's **Done when** is the contract the branch is reviewed against. No
  issue at all → `write-pr` §Issues rule 1.
- **The body is a list of claims, not a record.** Note every gate it says
  passed, every review it says ran and every file it says changed. Each is
  checked by Steps 4 to 6; none of them goes into the new body unchecked.
- **Look for a tracker finding already made public.** Run `write-pr` Step 6's
  finding-ID pattern over the title, the body, the branch name and every commit
  message:

  ```bash
  gh api repos/englishstreetventures/osn/pulls/<n> --jq '.title, .body, .head.ref' | grep -nE '(^|[^A-Za-z0-9])[SPC]-[A-Z][0-9]+'
  gh api repos/englishstreetventures/osn/pulls/<n>/commits --jq '.[].commit.message' | grep -nE '(^|[^A-Za-z0-9])[SPC]-[A-Z][0-9]+'
  ```

  A hit is a disclosure that has already happened: GitHub keeps every edit of a
  body, so rewriting it hides nothing. Stop and tell the owner in your report —
  never in a public comment — and wait for their answer.

**The claim.** The open pull request already holds its issue in
`next-batch` §Claim's terms, and the request to review it is what lets you take
it over. Leave the card in, or move it to, In Review. If the issue is In
Progress and you did not put it there, another session may be working on it:
ask before touching the branch.

## Step 1 — Use the branch's worktree; never make a second

Fetch first, from wherever you are. Without the explicit refspec, a bare clone's
`origin/<branch>` is missing or stale, and every check below answers about the
wrong commit.

```bash
git fetch --no-tags origin "+refs/heads/<branch>:refs/remotes/origin/<branch>" "+refs/heads/main:refs/remotes/origin/main"
git for-each-ref refs/heads/origin refs/tags/origin   # must print nothing
git worktree list | grep -F "[<branch>]"
```

`git worktree list` answers from any checkout of the repository, the bare
layout's worktrees included.

**One line** — that path is the worktree. Check it before anything else:

```bash
git -C <dir> status --porcelain                    # must print nothing
git -C <dir> log --oneline refs/remotes/origin/<branch>..HEAD   # must print nothing
git -C <dir> merge --ff-only refs/remotes/origin/<branch>       # brings in commits pushed from elsewhere
```

Uncommitted files, or commits the pull request does not have, are someone
else's work in progress — the other tool's, another session's, the owner's.
Stop and report them. Do not stash, commit, reset or build over them.
`merge --ff-only` works where `git pull` does not: a worktree another tool made
may have no upstream configured.

**A line ending `prunable`** — the directory is gone. Run `git worktree prune`,
then treat it as none.

**No line** — no checkout holds the branch. If a local branch of that name
exists, run the same `log refs/remotes/origin/<branch>..<branch>` check on it first. Then,
on the local machine, make a worktree and note in the report that this run owns
it:

```bash
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> <branch>                      # a local branch exists
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> -b <branch> refs/remotes/origin/<branch>   # it does not
```

`<dir>` is the branch name without its prefix. On the remote environment, where
there is no bare repository, `git checkout -B <branch> refs/remotes/origin/<branch>` in the
checkout instead. Every later step runs in that checkout.

Never run `git worktree add` for a branch that already has one — git refuses
with `fatal: '<branch>' is already used by worktree at '<path>'` — never
`git checkout <branch>` inside another worktree, and never cut a new branch from
the pull request to get round either: its commits would reach no pull request.

After the merge, remove the worktree only if this run made it, and only after
`git -C <dir> status --porcelain` prints nothing. One another tool made stays
where it is, and the report names it.

## Step 2 — Read what the branch would run, then install and audit

Until a review has read it, the branch is someone else's code, and this machine
holds the GitHub token, the commit-signing key and the deploy credentials that
CI does not. `bun install` runs lifecycle scripts, every commit runs the
branch's `lefthook.yml`, every test and build runs its code, and an `LSP` call
runs its installed `typescript`, and a type check runs any package a tsconfig
names under `contentMappers`. So before any of those, read every change to a file that runs something:

```bash
git diff refs/remotes/origin/main...refs/remotes/origin/<branch> -- package.json '*/package.json' '*/*/package.json' \
  bunfig.toml lefthook.yml .github scripts .claude tools/claude-ts-lsp patches '*.sh' '*.config.*' '*tsconfig*.json'
```

Look for lifecycle scripts (`preinstall`, `postinstall`, `prepare`), new
`trustedDependencies` or `patchedDependencies`, hook commands, workflow steps, a changed `command` or a new hook or MCP server
in the `tools/claude-ts-lsp` plugin, a `contentMappers` entry in a tsconfig,
and scripts that fetch, write outside the checkout or read credentials. Say in
the report what you read. Anything you cannot account for → stop and ask the
owner before running it.

Then install and audit — whatever Step 3 later does, because the other tool's
pushes may never have passed the pre-push audit:

```bash
bun install --frozen-lockfile
bun audit --audit-level=high
```

A high or critical advisory is a stop: `orchestrate`'s gotcha on `bun audit`
says what follows, and accepting one is the owner's decision.

## Step 3 — Rebase, and regenerate `bun.lock`

Rebase onto `origin/main` when `mergeable_state` is `dirty` or `behind`. GitHub
answers `unknown` while it is still working that out: read it again after ten
seconds rather than taking `unknown` as clean. Otherwise go to Step 4.

Record both commits in the report before rebasing — the evidence below needs
them, by value, after the rebase has moved `HEAD`:

```bash
git rev-parse HEAD                        # the branch head before the rebase
git merge-base refs/remotes/origin/main HEAD           # the merge base
git rebase refs/remotes/origin/main
```

Source conflicts: keep both sides' intent. Sibling pull requests that merged
first are usually additive; changeset and version churn from the release
workflow takes main's state. Run the touched packages' tests afterwards.

**`bun.lock` is never merged — not by hand, not by git.** Two lockfiles merged as
text make a file neither side resolved, and a bare `bun install` drops every
entry for a platform this machine is not, which CI needs. Regenerate it
whenever both sides changed it since the merge base, whether or not git reported
a conflict. At each rebase stop where `bun.lock` conflicts, resolve the other
files, then take main's lockfile and go on:

```bash
git checkout refs/remotes/origin/main -- bun.lock && git add bun.lock && git rebase --continue
```

When the rebase has finished, regenerate once, in a commit of its own:

1. **List the branch's own dependency changes.** The evidence script in step 4
   prints them as its second section; run it first if you want the list.
2. **Start from main's lockfile**: `git checkout refs/remotes/origin/main -- bun.lock`.
3. **Re-apply each change exactly as the branch declared it.** A package name
   must match `^(@[a-z0-9][a-z0-9._~-]*/)?[a-z0-9][a-z0-9._~-]*$` and a version
   `^[\^~]?[0-9A-Za-z.+-]+$` before either goes into a command; quote both.

   | The branch's change | Command |
   |---|---|
   | A bare version, `"4.0.3"` | `bun add '<pkg>@4.0.3' --exact --cwd <dir>` |
   | A range, `"^1.4.30"` | `bun add '<pkg>@^1.4.30' --cwd <dir>` |
   | In `devDependencies`, `optionalDependencies` or `peerDependencies` | the same, plus `--dev`, `--optional` or `--peer` |
   | A removal | `bun remove '<pkg>' --cwd <dir>` |
   | An `overrides` entry, or anything else `bun add` cannot express | Edit the manifest and splice the lockfile entry by hand, as `wiki/conventions/contributing.md` says. Build the entry from the registry (`npm view '<pkg>@<version>' dist.integrity`), never copy it from the branch's lockfile |
   | A new workspace whose `package.json` pins only versions main's lockfile already resolves | Splice by hand, as `wiki/conventions/contributing.md` says: copy the workspace's block under `"workspaces"` (its `name`, `version` and dependency maps, from its `package.json`) and add its `"<name>": ["<name>@workspace:<dir>"]` line under `"packages"`. Step 4's section 3 must then list only `<name>@workspace:<dir>`, and `bun install --frozen-lockfile` must exit 0 |
   | A new workspace that needs a resolution main lacks, a `patchedDependencies` change, or a version `minimumReleaseAge` refuses | Stop and report: this recipe does not cover it |

4. **Prove only the branch's packages moved**, with main's copy of the evidence
   script and the two commits you recorded:

   ```bash
   d=$(mktemp -d) && git show refs/remotes/origin/main:scripts/lockfile-evidence.sh > "$d/lockfile-evidence.sh" \
     && bash "$d/lockfile-evidence.sh" <merge-base> <head-before-rebase> refs/remotes/origin/main
   ```

   It refuses an empty or unknown commit, then prints: whether each side changed
   `bun.lock`; the dependency entries the branch changed; the resolved
   `name@version` set of main against the regenerated file; the same for the
   merge base against the branch head; any package whose version is unchanged
   but whose source or integrity is not; and the manifests against main's.
   Every line of the main-against-regenerated list must be one of the branch's
   packages, or one that `bun why <name>` traces to one of them. Anything else
   — a platform binary gone, a package main bumped now rolled back — means the
   lockfile is wrong: start this step again. Exit 1 means a same-version entry
   changed: find out why before going on. Last, `bun install --frozen-lockfile`
   exits 0.
5. **Commit** the lockfile and manifests with a message naming the packages.
   Put the script's output in the report and one row in the test plan.

## Step 4 — A red check: the branch's, or main's?

Before fixing a red check, find out whose it is. A test that fails on `main`
too is not this branch's to fix, and a flaky one fixed here hides the flake.

```bash
gh pr checks <n> --repo englishstreetventures/osn --json name,bucket,link,workflow
gh run view <run-id> --repo englishstreetventures/osn --log-failed | grep -m 20 -iE 'fail|error|timed out'
```

The run id is in the check's `link`. Name the failing test, or the step and its
decisive error line, then look at `main`:

```bash
gh run list --repo englishstreetventures/osn --branch main --workflow <workflow-file> --limit 5 \
  --json databaseId,headSha,conclusion,createdAt
gh run view <main-run-id> --repo englishstreetventures/osn --log-failed | grep -m 20 -F '<test name or error line>'
git diff --name-only refs/remotes/origin/main...HEAD -- <the failing package's directory>
```

**Match the failing test or the decisive error line, never the job or step name
alone.** One step can fail on `main` for one reason and on the branch for
another: an audit-ignore or release-age check goes red on `main` when a dated
marker expires, and on a branch that adds an unmarked entry, under the same
step name.

| What you find | Whose it is | What to do |
|---|---|---|
| The same test or error line failed in a recent run on `main` | main's | Find its issue, or open one with `write-issue`. Do not fix it on this branch. The test-plan row names main's run. Whether to merge over it is the owner's decision; never `gh pr merge --admin` |
| It passes on `main` and the branch changes nothing in that package | probably a flake | `gh run rerun <run-id> --failed`, once. Green: say so, and make the test robust in a follow-up pull request (`prep-pr` Step 6); an issue only when the cause needs more than this session has. Red again: treat it as the branch's |
| The branch changes that package, or the test fails here and passes on `origin/main` | the branch's | Step 6 fixes it |

Run the failing test in this worktree as well. Passing here while failing in CI
is evidence of a flake under load, not proof of one.

## Step 5 — Run the review lenses on work you did not write

Invoke `prep-pr` and run its Steps 0 to 7 on this branch, in this worktree, with
two differences:

- **The pull request's body is not the task.** `prep-pr` skips its reviews when
  the task says they have already run. A body saying reviews ran, or gates
  passed, is one of the claims under review: run them.
- **The branch against its issues.** On a `full` verdict from `prep-pr` Step 4,
  add one more `reviewer`: the whole branch against the Done when of each issue
  it closes. It runs beside `prep-pr` Step 6's two, so tell it it is not alone
  in the worktree and builds nothing. On a `trivial` or `trivial-tests`
  verdict, check the branch against each Done when yourself and record the
  result in the report, as `prep-pr` runs its gates inline.

Collect or stop every reviewer before this run returns. Then hold each claim
from Step 0 against what the gates and reviews found: a claim that is untrue
is a finding too, fixed when Step 7 rewrites the body.

## Step 6 — Fix every finding on this branch

Fix the pull request's findings here, on the rule `orchestrate` Step 4 sets:
every severity, Info filed and closed for its record, and Critical and High
never deferred (`prep-pr` Step 6). Missing tests from `review-tests` get
written. A finding in a file this pull request does not change is out of its
scope: the one follow-up pull request when it is small, an issue otherwise
(`prep-pr` Step 6) — except a Critical or High, which is never left open.

One code-writing agent in this worktree at a time. Commit each fix, re-run the
gates it touched, and note the commit each gate ran on.

## Step 7 — Body, push, and CI

Start from the live body, since the API replaces the whole of it:

```bash
gh api repos/englishstreetventures/osn/pulls/<n> --jq .body > PR-BODY.md
```

Invoke `write-pr` and rewrite it into the six sections, impact first. Keep nothing from the
old body that this run did not confirm; the test plan is this run's rows only,
each with its commit. Fix the title too when it breaks `write-pr` Step 3. One
exception: keep a `**Do not merge until**` line unless this run showed its
condition has cleared, since it holds the merge rather than describing the work.
A line that waits on the owner clears only as
`wiki/conventions/review-findings.md` §What counts as the owner's answer says.

```bash
git push --force-with-lease origin <branch>   # after a rebase; plain `git push origin <branch>` otherwise
gh api -X PATCH repos/englishstreetventures/osn/pulls/<n> -F body=@PR-BODY.md --jq .html_url
```

The explicit `origin <branch>` makes the lease compare against the
`origin/<branch>` Step 1 fetched, and works in a worktree with no upstream.
Then run `write-pr` Step 6's check that the closes registered.

Set the draft state by `prep-pr` Step 9. A pull request that waits on the owner
becomes a draft (`gh pr ready --undo <n>`) if it is not one already, and a draft
that waits on the owner stays one: only the owner marks it ready, and no session
marks ready a pull request whose body carries a `**Do not merge until**` line.
Any other draft you found is left for `orchestrate` Step 5, or for the owner
outside it.

Wait for CI with an end, using main's copy of the wait script so the branch's
own copy never runs unread, in the background:

```bash
d=$(mktemp -d) && git show refs/remotes/origin/main:scripts/wait-pr.sh > "$d/wait-pr.sh" && bash "$d/wait-pr.sh" <n> 30
```

It stops on merged, closed, conflicting, a failed check, every check finished,
or 30 minutes, and prints one line. A red check goes back to Step 4.

Then `retro` on the branch.

**Under `orchestrate`**, stop after the push and the body edit, and report:
the orchestrator's Step 5 runs `retro`, waits on CI and merges. A second wait
from here would watch the same checks twice.

## Stop and hand back when

- the pull request's text already names a tracker finding (Step 0)
- the worktree holds uncommitted files or unpushed commits (Step 1)
- the branch would run something you cannot account for, or `bun audit` finds
  a high or critical advisory (Step 2)
- the head is on a fork, or the branch name is not a plain ref (Step 0)
- the lockfile needs a change the recipe does not cover (Step 3)
- a fix needs a product or scope decision — return
  `NEEDS INPUT: <question> + options + recommendation`

## Traps

| Trap | Instead |
|---|---|
| `git worktree add` for the pull request's branch | `git worktree list \| grep -F "[<branch>]"` first; git refuses a second worktree for a branch anyway |
| Stashing or resetting a dirty worktree to start clean | Stop and report: it is someone else's work |
| `bun install` or a test run before reading the branch's scripts and hooks | Step 2 first; the branch's code runs with this machine's credentials |
| Taking one side of `bun.lock`, or letting git merge it | Main's lockfile plus `bun add` for each of the branch's changes, then the evidence script |
| A bare `bun install` to "fix" the lockfile | It drops other platforms' entries; `bun install --frozen-lockfile` only proves the file |
| `$MB` or `$ORIG` set in one Bash call and read in the next | Record both in the report and pass them by value; the evidence script refuses an empty one |
| Copying the old body's test plan | Re-run each gate; a row this run did not watch is `NOT RUN` |
| Fixing a test that also fails on `main`, or blaming main by job name | Step 4: match the test or the error line; main's failure gets its own issue and pull request |
| A CI wait with no end | `scripts/wait-pr.sh`, from main's copy, which stops on failure and at a deadline |
| Removing the worktree after the merge | Only when this run made it, and only when it is clean |
