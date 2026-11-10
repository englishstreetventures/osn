---
title: Stacked PRs
description: How to open a PR on top of another PR with the gh CLI, so GitHub shows the stack instead of a 900-line diff
tags: [convention, workflow, git]
related:
  - "[[contributing]]"
  - "[[review-findings]]"
  - "[[commands]]"
last-reviewed: 2026-11-10
---

# Stacked PRs

One goal, several PRs, each reviewable on its own. PR 2 branches off PR 1's branch instead of `main`, so its diff shows only its own work.

There are two separate things to get right, and only doing both gives the result we want:

1. **The base branch** — what the PR merges into, and therefore what its diff contains.
2. **The stack itself** — a first-class object on GitHub that renders the chain, orders it, and merges it. GitHub does **not** infer a stack from base branches alone. A correctly-based PR still shows no stack widget until the stack is registered.

That second half is what used to get done by hand in the web UI. `gh stack` does it from the CLI.

## The tool

Stacked PRs live in a `gh` extension, in public preview:

```bash
gh extension install github/gh-stack   # once per machine; needs gh >= 2.0
gh stack --help                        # presence check
```

Check for it before relying on it. Claude Code's remote environments do not have it preinstalled, and the install needs network:

```bash
if gh stack --help >/dev/null 2>&1; then :; else gh extension install github/gh-stack; fi
```

If the install cannot run, fall back to base chaining (below). The fallback produces correct diffs and a correct merge order — it only skips registering the stack, and the stack can be registered later from any machine, because `gh stack link` needs no local state.

## Registering the stack: `gh stack link`

`gh stack link` is the command that fits this repo. It takes branches or PR numbers **bottom to top**, needs no local stack-tracking state, and works with branches managed by anything — including our bare-repo-plus-worktree layout, where one branch per worktree means the local stack state a full `gh stack init` wants does not exist.

```bash
gh stack link <bottom-pr> <middle-pr> <top-pr>          # PR numbers
gh stack link chore/rules feat/api feat/ui              # or branch names
gh stack link 7 <new-pr>                                # append to existing stack 7
gh stack link --base develop <bottom> <top>             # non-default trunk
```

It pushes any branch that is not on the remote, opens a PR for any branch that has none, and chains the bases itself. Existing PRs are reused and never dropped. Two arguments minimum.

Run it once the second PR of a stack exists, and again with the new PR appended each time the stack grows.

Everything else the extension offers — `gh stack init/add/submit/sync/rebase`, the navigation verbs — assumes local stack tracking in one checkout. Reach for them only in a single-checkout clone.

`gh stack view` is in that group too, which is easy to miss: `link` registers the stack on GitHub and writes **no local state**, so `view` reports `current branch "<name>" is not part of a stack` on a stack that exists and renders fine on GitHub. It is not a failure. To read the stack locally, import the tracking first — `gh stack checkout <stack-number>` (the number `link` printed) is a no-op on the branch you are already on, and prints the chain:

```
$ gh stack link 713 716
✓ Created stack with 2 PRs (stack #717)

$ gh stack checkout 717
✓ Imported stack with 2 branches from GitHub (stack #717)
Stack: (main) <- fix/cire-rsvp-batch-ceiling <- perf/cire-rsvp-roundtrips
```

## The base branch

Three ways to set it, in preference order. Do this regardless of whether the stack gets registered — the base is what controls the diff.

### 1. Record the merge base when the worktree is created

Store the parent in git config as `branch.<current>.gh-merge-base`. `/prep-pr` Step 0 reads it into `$BASE`, every later diff in that run uses it, and the `write-pr` skill passes it as the pull request's `base`:

```bash
git worktree add /Users/ac/.work/osn.git/<dir> -b <prefix>/<slug> <parent-branch>
git -C /Users/ac/.work/osn.git/<dir> config branch.<prefix>/<slug>.gh-merge-base <parent-branch>
```

Note the branch is cut from `<parent-branch>`, not `origin/main` — a stacked branch that starts at `main` has nothing to stack on.

For the bottom of a stack, cut from `origin/main` as usual and set nothing; `/prep-pr` falls back to `main`.

### 2. Pass the base at creation

Pull requests here are opened through REST (`write-pr` Step 6), and `base` is a required field with no default — it reads no git config:

```bash
gh api repos/englishstreetventures/osn/pulls \
  -f title="…" -f head="<branch>" -f base="<parent-branch>" -F body=@PR-BODY.md
```

`base` is the branch the code merges **into**. Add `-F draft=true` when the pull request waits on the owner (the `prep-pr` skill, Step 9).

### 3. Repair an already-open PR

```bash
gh api -X PATCH repos/englishstreetventures/osn/pulls/<number> -f base=<parent-branch>
```

Same effect as changing the base in the web UI. Retargeting rewrites the diff; re-read it before asking for review.

A pull request in a registered stack cannot be retargeted: GitHub answers `422` with "Cannot change the base branch because the pull request is part of a stack." Read the stack from the pull request (`gh api repos/englishstreetventures/osn/pulls/<number> --jq .stack`), remove it with `gh stack unstack <stack-number>`, which unstacks every pull request in it and leaves each base as it was, change the base, then link again whatever should stay stacked (`gh stack link <bottom> <top>`).

## Verify

Never assume. Two checks, one per half:

```bash
gh api repos/englishstreetventures/osn/pulls/<number> --jq '"\(.head.ref) -> \(.base.ref)"'
gh stack checkout <stack-number> # then: gh stack view, from any branch in it
```

Every PR but the bottom one must show its parent's branch as its base. A PR showing `main` is not stacked — fix the base.

For the other half, check the number `gh stack link` printed. `gh stack view` alone is not the check: it reads local tracking, which `link` never writes, so it says "not part of a stack" whether the stack is missing or merely unimported. Run `gh stack checkout <stack-number>` first — it fails loudly on a stack that does not exist, and prints the chain on one that does.

## Closing issues from a stacked PR

GitHub reads closing keywords only on a pull request whose base is the default branch. A stacked PR's `Closes` lines therefore link nothing while it sits on its parent, and `write-pr`'s closes check lists none. Check again once the parent merges and GitHub retargets the child to `main`; an issue still open after the child merges is closed by hand, with a comment naming the pull request.

## Merge order

With the `main` ruleset's merge queue on, `main` takes pull requests through it, testing each one on top of those ahead of it before it lands; [[commands#Migrations]] says why.

### A whole stack

Merge a linked stack whole when every pull request in it is ready, not a draft. A frontend stack ([[#Frontend: one component per pull request]]) is ready once the owner has marked its feature pull request ready and the merging session has marked the components ready ([[#Opening, approval and merge]]). A registered stack merges only this way: GitHub refuses `--auto` on any pull request in one.

```
GraphQL: Auto-merge is not supported for stacked pull requests. (enablePullRequestAutoMerge)
```

*Seen 2026-10-26 — `gh pr merge <n> --squash --auto` on a pull request in a registered stack.*

A stack that was never linked, or one merged from a machine without `gh stack`, merges one pull request at a time ([[#One pull request at a time]]).

```bash
gh api repos/englishstreetventures/osn/pulls/<any PR in the stack> --jq .stack.number
gh stack merge <stack number> --squash --yes
```

The second command adds the whole stack to the queue. Pass the stack's number, not a pull request's: the command reads a bare number as a stack number first. `--yes` skips the wizard it opens in an interactive terminal. The queue builds at most `max_entries_to_build` entries at once, so each round lands that many. The next entry still holds the squashed parents' original commits, so the queue removes it as a conflict. GitHub then rebases the rest onto `main` and their CI runs again; once it is green, the same command queues the next round. Read the live limits from the ruleset:

```bash
gh api repos/englishstreetventures/osn/rules/branches/main \
  --jq '.[] | select(.type=="merge_queue") | .parameters | {max_entries_to_build, check_response_timeout_minutes}'
```

*Read 2026-11-06: `max_entries_to_build` 5, `check_response_timeout_minutes` 60.*

- **Keep a stack within `max_entries_to_build`**, or have the owner raise it for the merge. Each round past it costs every pull request still waiting another CI run.
- **Queue only once the stack's own CI has settled.** The queue gives a group `check_response_timeout_minutes` to report, and removes one still waiting for runners the stack's CI holds.
- **A release between rounds can consume a changeset a waiting pull request edits.** GitHub's rebase then stops on that pull request, which still holds the original commits of the parent that merged. Rebase it by hand, taking the changeset's deletion; a wording change it carried goes to the line the release wrote in that package's `CHANGELOG.md`. A tip recorded locally is no use here, since GitHub rebases the stack on its own servers; use the parent's last head, which GitHub keeps after the merge as `refs/pull/<parent PR>/head`. In the branch's worktree:

  ```bash
  git fetch --no-tags origin "+refs/pull/<parent PR>/head:refs/remotes/origin/pr/<parent PR>" "+refs/heads/<branch>:refs/remotes/origin/<branch>" \
    "+refs/heads/main:refs/remotes/origin/main"
  git merge --ff-only refs/remotes/origin/<branch>
  git rev-parse HEAD   # record it: the lease, and the base the branches above rebase from
  if git merge-base --is-ancestor refs/remotes/origin/pr/<parent PR> HEAD; then
    git rebase --onto refs/remotes/origin/main refs/remotes/origin/pr/<parent PR>
  else
    git rebase refs/remotes/origin/main   # GitHub had already moved it onto main
  fi
  ```

  Then `bun install --frozen-lockfile`, and push with the lease pinned to the head you recorded, as [[#One pull request at a time]] does. Carry the branches above it up from that recorded head, as [[#Rebasing a stack]] says, then queue the next round.

### One pull request at a time

In a stack that was never registered, a child queued on its own with `gh pr merge <n> --squash --auto` waits for its parent to merge. When PR 1 merges, GitHub retargets PR 2 to `main`, provided PR 1 was merged rather than closed.

The retarget is not enough. PR 2's branch still carries PR 1's original commits, and the squash put different ones on `main`, so PR 2 still holds PR 1's changes. Any file `main` has since deleted comes back with it, a changeset `release.yml` consumed included. Before queueing PR 2, rebase it past them and push:

```bash
git rebase --onto refs/remotes/origin/main <PR 1's tip before the merge> <PR 2's branch>
bun install --frozen-lockfile
git push --force-with-lease=<PR 2's branch>:<its recorded head> --force-if-includes origin <PR 2's branch>
```

Pin the lease to the head you recorded. Every worktree shares one set of remote refs, so any session's `git fetch` refreshes a bare lease, and a commit pushed from elsewhere, such as a suggestion accepted in the web editor, would be overwritten without a word.

PR 1's tip is gone by then: the merge deletes its branch on GitHub and Step 5 of `orchestrate` deletes it locally. Record it when PR 2 is cut and after every rebase, as `git merge-base <PR 1's branch> <PR 2's branch>`. Queue a child only once its base is `main`. Only `main` has a ruleset, so a child still based on its parent's branch has no queue and no required checks, and `--auto` merges it into the parent at once.

Merging out of order, or closing a parent without merging, orphans the children: their base branch is deleted and the diff turns into everything since `main`. If that happens, `git rebase --onto main <old-parent> <child>` and `gh api -X PATCH repos/englishstreetventures/osn/pulls/<child> -f base=main`.

## Rebasing a stack

When `main` moves under a stack, rebase from the bottom and force-push each branch in order:

```bash
git rebase refs/remotes/origin/main <bottom> && git push --force-with-lease origin <bottom>
git rebase --onto <bottom> <old-base> <middle> && git push --force-with-lease origin <middle>
```

`--force-with-lease`, never `--force`. After any rebase, re-assert the property the PR was opened for — resolving a conflict can drop a fix while the diff still reads correctly.

After a rebase onto a newer `main`, run `bun install --frozen-lockfile` in the worktree before pushing. A workspace `main` added since the last install has no links in the worktree's `node_modules`, and the pre-push type check fails on it with `File '@shared/typescript-config/base.json' not found` — a fault in the install, not in the branch.

`gh stack rebase` and `gh stack sync` do the cascade in one command, but only in a checkout with local stack tracking. In the worktree layout, do it by hand as above.

## Cutting a stack from one worktree

A session isolated in one worktree is refused git commands aimed at any other, so it cannot cut a worktree per layer. When the layers split cleanly by path, a dead-code sweep for example, build the stack in that one worktree:

1. Make every layer's edits and changesets in the working tree, and run the gates once on the whole tree. Each changeset is a file of its own, so each can go in its layer's commit.
2. Save `git diff HEAD` and the list of untracked files to scratch outside the repository.
3. Commit bottom to top, staging each layer by path. `package.json` and `bun.lock` go in the bottom layer together, or a lower layer's lockfile disagrees with its manifests. After the last commit, `git status --porcelain` prints nothing.
4. Point each upper branch at its commit without checking it out: `git branch <name> <sha>`. Then `git reset --hard <bottom sha>`, and set `branch.<name>.gh-merge-base` on each upper branch.
5. Push every branch by name, open the pull requests bottom to top, and `gh stack link` them.

A fix to an upper layer after that is a plumbing commit: `git read-tree` that layer into a scratch index (`GIT_INDEX_FILE`), `git hash-object -w` the new file, `git update-index --cacheinfo`, `git write-tree`, `git commit-tree -p <layer>`, then `git update-ref`. A fix below the top also replays each later commit onto the new parent. Check each replayed commit's diff against its original.

The upper layers then have no local per-layer gates, since none was ever checked out. Their bodies say so, and CI on each pull request is their proof.

To rebuild such a stack on a newer `main`, when a layer conflicts with it:

1. Save the four tips, then `git diff <old bottom layer commit> <old top>` to scratch. Diff from the bottom *layer's own commit*, never the bottom branch's tip: commits added on the bottom after the cut, such as its session-metrics card, are not in the upper layers, and a diff from the tip deletes them.
2. `git rebase refs/remotes/origin/main` on the bottom branch, then `bun install --frozen-lockfile`.
3. `git apply --3way <diff>`. Resolve each conflict by keeping `main`'s new code and re-applying only the layer's intent, and check `main` for new readers of anything the layer removes.
4. Run the gates again, commit each upper layer with `git commit -o <its paths>`, move the branch refs with `git branch -f`, reset the bottom, and push all four with `--force-with-lease=<branch>:<old sha>`.
5. Confirm `git merge-tree --write-tree refs/remotes/origin/main <top>` prints a tree and no `CONFLICT` line.

## CI on a stacked PR

Path-filtered jobs must diff against the PR's own base, not `main`, or a stacked PR sees its parent's files as changed. `.github/workflows/ci-swift.yml` does this: on `pull_request` it diffs `origin/$BASE_REF`. Copy that shape for any new filter.

Changeset checks behave the same way, and `.github/workflows/changeset-check.yml` was fixed to match on 2026-08-21. It had `on: pull_request: branches: [main]`, which matches the PR's *base* — so a stacked PR never triggered it at all. Because the check is **required**, that did not skip the gate, it left every stacked PR blocked on a status that could never report. It now has no `branches:` filter and diffs `origin/$BASE_REF...HEAD`.

The consequence for authors: **each stacked PR needs a changeset in its own diff**, not just somewhere in the stack. The check sees only what that PR adds on top of its parent, which is the point — it is gating this PR, not the whole chain.

## When to stack, and when not to

Stack when the pieces share one goal and later pieces read the earlier ones' code. The components of one frontend feature share its goal even when they do not read each other: the feature reads them all ([[#Frontend: one component per pull request]]). Do not stack for unrelated work: two independent PRs off `main` merge in either order and never block each other.

Keep a stack short. Three deep is manageable; five means the bottom PR sat unreviewed too long.

## Frontend: one component per pull request

Frontend work that adds or changes a component in a UI package — `@shared/ui`, `@cire/ui`, `@osn/auth-ui` — ships as a stack. Each such component gets its own pull request, and the feature pull request sits on top. The feature PR only composes the components and adds the layout and styling between them. The owner reviews each component on its own; a change asked for in a component PR is made there and carried up by rebase.

A part used by one screen only, outside a UI package, is not a component here and stays in the feature PR. A fix for a private tracker finding is never a stack: it ships as one pull request named by area, as `new-feat` Step 0 says, since every branch in a stack is public while it waits.

### Who builds it

The `orchestrate` skill, from `main/`. A session that starts `new-feat` on such work hands over after the issue step and before the claim. `orchestrate` Step 00 then designs it, and its plan names each component, new or changed. That plan is where each component task's **Done when** comes from; the feature task's comes from the issue.

| Pull request | Branch | Cut from | Issue line |
|---|---|---|---|
| Component 1 | `<prefix>/<slug>-<component>` | `origin/main` | `Part of #N` |
| Component 2, 3 | `<prefix>/<slug>-<component>` | the branch below, once it has commits | `Part of #N` |
| Feature | `<prefix>/<slug>` | the top component branch | `Closes #N` |

At most three components under one feature, so four deep. More means the issue splits into two features.

- One issue, `#N`, claimed once at the first cut. Every brief carries `TASK-BRANCH:` and `CLAIMED: englishstreetventures/osn#N`, and the worktree and branch already cut.
- `ORCHESTRATE.md` records each branch's base (`git merge-base <parent> <child>`) and head at the cut and after every rebase or push. The rebases below need the base after the parent's branch is gone, and the lease and the owner's approval need the head.
- The agent comes from the `pick-agent` skill. A new component is `designer` work.
- A session-metrics card per pull request. A component PR's card records `part-of`, and the feature PR's carries #N's rating ([[session-metrics#Which issue a card names, and what it divides by]]).

### What a component pull request holds

- The component, and its lab stories under `tools/lab/src/stories/<package-dir>/`, one per state ([[component-lab]]). Its body lists the story ids (`write-pr`).
- The tests the component needs, as any component change does ([[component-library#Adding a new component]]); cire's mutation run passes on it alone. When the feature's E2E test later covers the same guarantee, the feature PR deletes the duplicate unless it checks a refusal ([[testing-patterns]]).
- Its own changeset. A change to `tools/lab` takes a `@tools/lab` changeset of its own, never shared with a `@cire/*` one. The bottom pull request adds every workspace package the stack's stories import to `tools/lab`, so `bun.lock` changes once.

### Opening, approval and merge

Each pull request opens as soon as its branch passes `prep-pr`, so the owner can review the bottom one while the next is built. Link the stack with `gh stack link` as each one opens. The issue moves to In Review when the feature PR opens.

The owner approves the stack as a whole, by marking the **feature** pull request ready. GitHub cannot record an approval here: sessions open pull requests as the owner, and an author cannot approve their own. So:

1. Every pull request in the stack opens as a draft (`prep-pr` Step 9).
2. Each component PR's `## Impact` ends with `**Do not merge until** #<feature PR> is marked ready by the owner.` The feature PR's line says the owner's review of the stack. The owner leaves component PRs as drafts.
3. When `orchestrate` parks the stack, it records each pull request's head commit in `ORCHESTRATE.md`. The owner's ready covers those commits and no others.
4. Once the owner marks the feature PR ready, `orchestrate` Step 5 first checks that every head still matches what it recorded. A head that moved means someone pushed after the review, through `review-pr`, a remote session or the web editor: put the feature back to draft (`gh pr ready --undo <feature PR>`), record the new heads and park again.
5. Then it removes each component's line, marks each component ready, and merges the stack whole with `gh stack merge <stack number> --squash --yes` ([[#A whole stack]]); a stack of four lands in one round. When a round stops on a conflict and a pull request is rebased by hand, it compares the patches first: `git range-diff <recorded base>..<old head> refs/remotes/origin/main..<new head>`. When every line pairs as `=`, the rebase changed nothing the owner saw: it pushes and queues the next round. When any patch changed, which means a conflict was resolved, it pushes, puts the feature back to draft and parks the stack again.
6. A review fix to any pull request after the owner marked the feature ready also puts the feature back to draft. The owner's ready covered the code they saw.

### Carrying a change up

A fix to a component pull request is made in that component's worktree. Then each branch above is rebased onto the new one, one at a time, by an `implementer` that resolves any conflict, `bun.lock` included:

```bash
git rebase --onto <parent branch> <recorded base> <child branch>
bun install --frozen-lockfile
git push --force-with-lease=<child branch>:<its recorded head> --force-if-includes origin <child branch>
```

Record the child's new base and head, then go up one. Never rebase a branch while a subagent is still building in it; wait for it to return. When parking removed a worktree, re-add it with `git worktree add <dir> <branch>`. A stacked pull request that GitHub shows `DIRTY` or `BEHIND` is rebased onto its parent branch, never onto `origin/main`. When the bottom one is rebased onto `main`, the whole stack above it is carried up the same way.

A remote session on a designated `claude/*` branch can push nowhere else, so it cannot cut a stack. It builds the bottom component pull request and reports the rest for a local `orchestrate` run.

## Related

- [[contributing]] — branch strategy, changesets, the rest of the PR workflow
- `.claude/skills/prep-pr/SKILL.md` — the gates every PR passes before it opens
- `.claude/skills/write-pr/SKILL.md` — the title, the body, and the REST command that opens and edits them
