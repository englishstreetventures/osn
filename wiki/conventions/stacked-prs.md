---
title: Stacked PRs
description: How to open a PR on top of another PR with the gh CLI, so GitHub shows the stack instead of a 900-line diff
tags: [convention, workflow, git]
related:
  - "[[contributing]]"
  - "[[review-findings]]"
  - "[[commands]]"
last-reviewed: 2026-10-28
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

With the `main` ruleset's merge queue on, `main` takes pull requests through it (`gh pr merge <n> --squash --auto`), testing each one on top of those ahead of it before it lands; [[commands#Migrations]] says why. A stack still merges bottom up, one at a time. When PR 1 merges, GitHub retargets PR 2 to `main`, provided PR 1 was merged rather than closed.

The retarget is not enough. PR 2's branch still carries PR 1's original commits, and the squash put different ones on `main`, so PR 2 still holds PR 1's changes. Any file `main` has since deleted comes back with it, a changeset `release.yml` consumed included. Before queueing PR 2, rebase it past them and push:

```bash
git rebase --onto refs/remotes/origin/main <PR 1's tip before the merge> <PR 2's branch>
bun install --frozen-lockfile
git push --force-with-lease=<PR 2's branch>:<its recorded head> --force-if-includes origin <PR 2's branch>
```

Pin the lease to the head you recorded. Every worktree shares one set of remote refs, so any session's `git fetch` refreshes a bare lease, and a commit pushed from elsewhere, such as a suggestion accepted in the web editor, would be overwritten without a word.

PR 1's tip is gone by then: the merge deletes its branch on GitHub and Step 5 of `orchestrate` deletes it locally. Record it when PR 2 is cut and after every rebase, as `git merge-base <PR 1's branch> <PR 2's branch>`. Queue a child only once its base is `main`. Only `main` has a ruleset, so a child still based on its parent's branch has no queue and no required checks, and `--auto` merges it into the parent at once.

`gh stack merge <pr-number>` merges every PR up to that one in one operation. It goes around the merge queue and the rebase above, so do not use it here.

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
5. Then it merges bottom up. For each child, it rebases the child past its merged parent ([[#Merge order]]) **before** releasing anything, and compares the patches: `git range-diff <recorded base>..<old head> refs/remotes/origin/main..<new head>`. When every line pairs as `=`, the rebase changed nothing the owner saw. It pushes, removes the line, marks the PR ready and queues it once its base is `main`. When any patch changed, which means a conflict was resolved, it pushes, puts the feature back to draft and parks the stack again.
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
