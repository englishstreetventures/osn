---
title: Stacked PRs
description: How to open a PR on top of another PR with the gh CLI, so GitHub shows the stack instead of a 900-line diff
tags: [convention, workflow, git]
related:
  - "[[contributing]]"
  - "[[review-findings]]"
  - "[[commands]]"
last-reviewed: 2026-09-01
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

### 1. Set the merge base when the worktree is created

`gh pr create` reads `branch.<current>.gh-merge-base` from git config. Set it once and every later `gh pr create` on that branch targets the parent, with no flag to forget:

```bash
git worktree add /Users/ac/.work/osn.git/<dir> -b <prefix>/<slug> <parent-branch>
git -C /Users/ac/.work/osn.git/<dir> config branch.<prefix>/<slug>.gh-merge-base <parent-branch>
```

Note the branch is cut from `<parent-branch>`, not `origin/main` — a stacked branch that starts at `main` has nothing to stack on.

For the bottom of a stack, cut from `origin/main` as usual and set nothing; `main` is already the default.

### 2. Pass the base at creation

```bash
gh pr create --base <parent-branch> --title "…" --body-file <path>
```

`--base` is the branch the code merges **into**. Use it when the config was not set, or in a checkout that is not a worktree.

### 3. Repair an already-open PR

```bash
gh pr edit <number> --base <parent-branch>
```

Same effect as changing the base in the web UI. Retargeting rewrites the diff; re-read it before asking for review.

## Verify

Never assume. Two checks, one per half:

```bash
gh pr list --repo xchromo/osn --state open --json number,headRefName,baseRefName
gh stack checkout <stack-number> # then: gh stack view, from any branch in it
```

Every PR but the bottom one must show its parent's branch in `baseRefName`. A PR showing `main` is not stacked — fix the base.

For the other half, check the number `gh stack link` printed. `gh stack view` alone is not the check: it reads local tracking, which `link` never writes, so it says "not part of a stack" whether the stack is missing or merely unimported. Run `gh stack checkout <stack-number>` first — it fails loudly on a stack that does not exist, and prints the chain on one that does.

## Merge order

Bottom up, one at a time. When PR 1 merges, GitHub automatically retargets PR 2 to `main` and drops PR 1's commits from its diff — no rebase, no force-push, provided PR 1 was merged rather than closed.

`gh stack merge <pr-number>` merges every PR up to that one as a single all-or-nothing operation. Convenient, and exactly what we do not want by default: each PR here is approved on its own. Use it only when the whole stack is already approved.

Merging out of order, or closing a parent without merging, orphans the children: their base branch is deleted and the diff turns into everything since `main`. If that happens, `git rebase --onto main <old-parent> <child>` and `gh pr edit <child> --base main`.

Squash-merging a parent is fine. The child's commits are unaffected; only the base pointer moves.

## Rebasing a stack

When `main` moves under a stack, rebase from the bottom and force-push each branch in order:

```bash
git rebase origin/main <bottom>          && git push --force-with-lease origin <bottom>
git rebase --onto <bottom> <old-base> <middle> && git push --force-with-lease origin <middle>
```

`--force-with-lease`, never `--force`. After any rebase, re-assert the property the PR was opened for — resolving a conflict can drop a fix while the diff still reads correctly.

`gh stack rebase` and `gh stack sync` do the cascade in one command, but only in a checkout with local stack tracking. In the worktree layout, do it by hand as above.

## CI on a stacked PR

Path-filtered jobs must diff against the PR's own base, not `main`, or a stacked PR sees its parent's files as changed. `.github/workflows/ci-swift.yml` does this: on `pull_request` it diffs `origin/$BASE_REF`. Copy that shape for any new filter.

Changeset checks behave the same way, and `.github/workflows/changeset-check.yml` was fixed to match on 2026-08-21. It had `on: pull_request: branches: [main]`, which matches the PR's *base* — so a stacked PR never triggered it at all. Because the check is **required**, that did not skip the gate, it left every stacked PR blocked on a status that could never report. It now has no `branches:` filter and diffs `origin/$BASE_REF...HEAD`.

The consequence for authors: **each stacked PR needs a changeset in its own diff**, not just somewhere in the stack. The check sees only what that PR adds on top of its parent, which is the point — it is gating this PR, not the whole chain.

## When to stack, and when not to

Stack when the pieces share one goal and later pieces read the earlier ones' code. Do not stack for unrelated work: two independent PRs off `main` merge in either order and never block each other.

Keep a stack short. Three deep is manageable; five means the bottom PR sat unreviewed too long.

## Related

- [[contributing]] — branch strategy, changesets, the rest of the PR workflow
- `.claude/skills/prep-pr/SKILL.md` — the skill that opens these PRs
