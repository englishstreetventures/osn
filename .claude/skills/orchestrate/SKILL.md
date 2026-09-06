---
name: orchestrate
description: Use when driving one or more tasks end to end from the local bare-repo root — a feature designed with the user first when its scope is open, or a ready list of tasks — ordering them, cutting a worktree per task, handing each to a subagent that runs new-feat, running prep-pr with every finding fixed rather than reported, and shepherding each pull request to a squash merge and worktree teardown. Not for a one-file change, and not outside the bare repo.
---

Orchestrate `$ARGUMENTS` end to end. If it is empty, ask for the task or tasks first.

You are the orchestrator: you order the work and drive the loop, and you **do not plan or write the implementation of any task** — a subagent does that through `new-feat`. Your context is the scarce one; theirs is disposable.

## What this run must produce

Every task merged into `main` as its own squash-merged pull request, its worktree removed, and a closing summary: each PR (number and one line), anything deferred as a tracked follow-up, and any deploy-time or human action a subagent surfaced.

## Precondition — the bare-repo root only

This skill creates worktrees, so it runs only in the local bare-repo setup:

```bash
git rev-parse --is-bare-repository 2>/dev/null                              # expect: true
[ -d /Users/ac/.work/osn.git ] && [ "$(uname)" = "Darwin" ] && echo OK
```

Anywhere else — the remote environment, a container, or inside a worktree — **stop** and say: "orchestrate needs the local bare repo root so it can create worktrees — run it from `/Users/ac/.work/osn.git`, or use `new-feat` and `prep-pr` in place instead." There is no static equivalent of this run; the deliverable is merged pull requests.

## Step 00 — Feature or task list?

Classify the input before ordering anything.

- **A ready task list** — concrete changes, each with clear acceptance criteria ("add `weddingName` to the vendor enquiries response", "wire `astro check` into the two cire frontends"). Go to Step 0.
- **A feature** — open scope, needs product or design direction, spans subsystems, or is big enough to want phases. Run the design phase first. When unsure, treat it as a feature: a short design gate is cheaper than a subagent guessing at scope.

**The design phase is interactive; the build loop is not.** Do it with the user, synchronously, before any subagent exists:

1. `superpowers:brainstorming` turns the idea into an approved spec at `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`. It has a hard gate — no worktree, no plan, no implementation until the user approves — and a feature spanning independent subsystems comes out as sub-project specs, which become your phases.
2. `superpowers:writing-plans` turns each approved spec into a task-by-task plan at `docs/superpowers/plans/YYYY-MM-DD-<name>.md`, one per phase. Note each plan's **Global Constraints**; they go into every dispatch.
3. The ordered phases are the tasks Step 0 orders — one phase, one branch, one PR. Inside a phase, the plan's tasks are the subagent's work, not yours.

Point every dispatch and every reviewer at the phase's **plan file path** and its Global Constraints. The plan is the single source of requirements; do not paste task detail into a dispatch.

For a feature with more phases than prose can hold, a `.canvas` beside the plan (`obsidian:json-canvas` — one node per phase, edges for dependencies, labelled with the files two phases both touch) lets the user check the ordering. Optional, and the plan file stays the source of truth.

## Step 0 — Order the work

Parse the input into discrete tasks and plan **structure only**:

- **Order by dependency.** A task another builds on, or that touches files another touches, goes first. Independent tasks still run through this loop one at a time; parallelise only when they share no files and you will manage separate worktrees.
- **One task, one branch, one PR** by default. Group two only when they are genuinely one unit of work.
- **A task with no clear acceptance criteria is not dispatched.** Ask the user to clarify before a subagent guesses at scope; if it needs product direction, that is Step 00.

State the ordered list and which tasks get their own branch in one short message, then start. Do not describe how any task will be built.

## Per task — Steps 1 to 5, in order

### Step 1 — Gather context, lightly

Collect **orientation pointers** for the subagent: the files in play, the pattern to copy from elsewhere in the repo, the schema and types involved, the footguns. `Explore`, grep, Read. This is context, not a design.

**Hit the wiki before the source** — its system pages already hold the contract, the finding history and the footguns. Use the three-tier ladder in `CLAUDE.md` §Searching the wiki, pulling one heading (`get_note_outline`, `get_vault_file_partial`) rather than a whole page. Hand the subagent **wiki page paths, not pasted prose**: it has its own context window. Include the pages the task will make stale — that is `prep-pr`'s docs work list.

### Step 2 — Worktree and branch

```bash
git -C /Users/ac/.work/osn.git fetch origin main
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> -b <prefix>/<dir> origin/main
(cd /Users/ac/.work/osn.git/<dir> && bun install)      # a fresh worktree has no node_modules
```

`<prefix>` is `feat/`, `fix/`, `chore/`, `refactor/` or `docs/`; `<dir>` is the branch name without it. Skip only when the task genuinely continues an existing, unmerged branch. A task that stacks on an open PR's branch is cut from that branch and gets `git config branch.<name>.gh-merge-base <parent>` — `wiki/conventions/stacked-prs.md`.

### Step 3 — Hand the task off, whole

Dispatch **one** `general-purpose` subagent that owns planning and implementation. Give it the task, the Step 1 pointers, the worktree path and branch, and these instructions:

- Invoke the `new-feat` skill and follow it — it routes to the right sub-skills. Plan the implementation itself; do not wait for a plan from you.
- Match repo conventions (`CLAUDE.md`, the product's `wiki/apps/<product>-development.md`), add the changeset, follow the observability rules, write tests — TDD where there is logic.
- Edit wiki pages with Edit/Write in its own worktree, invoking `obsidian:obsidian-markdown` for the syntax. Say explicitly: the Obsidian MCP and the `obsidian` CLI both point at `main`'s `wiki/`; they read, never write.
- **Commit on the branch; do not push and do not open a PR** — Step 4 owns that.
- On a decision it cannot resolve from the context and sensible defaults, **stop and return `NEEDS INPUT: <question> + options + recommendation`** rather than guess.

Do not re-implement or second-guess its design. Its final message is a report to you, not to the user.

For a **large phase** — a plan with many independent tasks — tell the subagent to run `superpowers:subagent-driven-development` against the plan file instead of `new-feat`: a fresh implementer per task, a review per task, a review of the whole branch, all inside the one branch. Still one PR; `prep-pr` runs once at the end.

### Step 4 — `prep-pr`, with findings fixed

Run the `prep-pr` skill on the branch. Its own steps validate the changeset, build and test, run `review-tests`, and run the performance and security reviews in parallel. This skill's contract is stronger: **after the reviews, dispatch fix subagents to add the missing tests and fix every security and performance finding** — Critical, High and Medium at minimum, Low and Info when cheap — then re-verify. A finding deliberately deferred is carried into the PR body as a tracked follow-up. Scale review depth to the change: a docs or config PR does not need three review agents; an auth, route or binding change does. Then the five-section PR body, push, and open the PR.

### Step 5 — Watch, merge, tear down

Delegate this to a **PR-shepherd subagent** — the slow CI polling should not sit in your context. It polls to a terminal state, merges, and removes the worktree:

```bash
gh pr ready <n>                                                       # if opened as a draft; then wait ~10 s before reading state
gh pr view <n> --json mergeStateStatus,statusCheckRollup,state
```

- All checks green and `mergeStateStatus: CLEAN` → `gh pr merge <n> --squash --delete-branch`.
- `DIRTY` or `BEHIND` → rebase onto the latest `origin/main`, resolve conflicts (sibling PRs that merged first are usually additive — keep both sides; for changeset or version churn from the release workflow, take the regenerated state), re-run the touched package's tests, `git push --force-with-lease`, re-poll.
- A real check failure → read the failing job, dispatch a fix subagent, push, re-poll. Never merge red.
- Once `MERGED`, the shepherd runs `git worktree remove --force <dir>`, deletes the local branch, and reports back. Never leave a merged task's worktree behind.

**Between dependent tasks:** `git fetch origin main` and fast-forward local `main` so the next worktree is cut from the updated tip. If a later task's branch already exists and now conflicts, rebase it before its Step 5.

## Handling subagent questions

Subagents cannot prompt the user; they surface `NEEDS INPUT` in their report. Then:

1. **Answer it yourself** from the task, the codebase, repo conventions, prior decisions this session and sensible defaults — by continuing that agent (`SendMessage` to its id) or by dispatching the next step with the decision baked in.
2. **Escalate to the human only when it is genuinely their call** — a product or scope choice, a value only they hold (real domains, account ids, legal copy), spend, anything outward-facing or irreversible. Ask concisely with clear options, then feed the answer back.
3. Never let a subagent block silently or guess on a consequential decision.

## Gotchas

The full table, with the reason behind each, is `references/gotchas.md`. The ones that cost a run:

- Feature input dispatched straight into the loop → the subagent guesses scope. Step 00 first.
- `gh pr ready` does not propagate at once; a still-draft PR shows `BLOCKED` with green checks. Wait, then read.
- Pre-push runs `bun audit --audit-level=high`. An advisory in an installed package is a real stop; do not push with `--no-verify` to get past one — fix or override it in `package.json` and say so in the PR.
- Merging several PRs in sequence: the release workflow versions on every merge, so sibling PRs touching `wrangler.toml` or an `index.ts` conflict. Merge in dependency order and rebase additively.
- Wrangler named environments inherit no top-level bindings. Every `[[d1_databases]]`, `[[r2_buckets]]` and `[images]` is mirrored into `[env.production]` and `[env.dev]`; verify with `wrangler deploy --dry-run`.

## When not to use this

A one-line or single-file change — edit it and open the PR directly. Outside the bare-repo root — `new-feat` then `prep-pr` in place.
