Orchestrate one or more tasks end-to-end for: $ARGUMENTS

If $ARGUMENTS is empty, ask the user for the task(s) before proceeding.

`/orchestrate` automates the full loop you would otherwise drive by hand: **gather context → prep a worktree → hand the task wholesale to a subagent (which uses `/new-feat` to plan + implement) → run `/prep-pr` (adding missing tests + fixing every security/performance finding, not just reporting them) → watch the PR on GitHub and squash-merge when green (or rebase-and-resolve conflicts).** You are the orchestrator: you plan the ordering and drive the loop, but you do **not** plan or write the implementation of any task — that is the subagent's job.

---

## Precondition — bare-repo root ONLY

This skill creates git worktrees, so it only runs in the **local bare-repo setup** (the `PERSONAL` environment from `/new-feat`). Check first:

```bash
git rev-parse --is-bare-repository 2>/dev/null   # expect: true  (run from the bare repo root)
[ -d /Users/ac/.work/osn.git ] && [ "$(uname)" = "Darwin" ] && echo OK
```

If this is **not** the bare-repo root (e.g. the Claude Code remote/container, or you're inside a worktree), **stop** and tell the user: "/orchestrate needs the local bare repo root so it can create worktrees — run it from `/Users/ac/.work/osn.git`, or use `/new-feat` + `/prep-pr` in-place instead."

---

## Step 0 — Plan ordering & structure (you do this)

Parse `$ARGUMENTS` into one or more discrete **tasks**. Then plan — **structure only, not implementation**:

- **Order** the tasks by dependency (a task that another builds on, or that changes files another touches, goes first). Independent tasks can still run sequentially through this loop; only parallelize if they share no files and you'll manage separate worktrees.
- **Branch/worktree per task** by default (one task = one branch = one PR). Group two tasks into one branch only if they are genuinely a single unit of work.
- Note any task that is too ambiguous to hand off (no clear acceptance criteria) — for those, **ask the user to clarify** before dispatching (don't make a subagent guess at scope). If a task needs creative/product direction first, run `/brainstorm` (superpowers:brainstorming) with the user before orchestrating it.

State the plan (the ordered task list + which gets its own branch) in one short message, then start executing. Do not detail *how* each task will be built.

---

## Per task — run Steps 1–5 in order, one task at a time (unless truly parallel)

### Step 1 — Gather necessary context (light)

Explore the codebase to collect **orientation pointers** for the subagent — relevant existing files, the patterns/conventions in play, reference implementations elsewhere in the repo, the schema/types involved, and any footguns. Use `Explore`/grep/Read. This is **context, not a design** — do not produce an implementation plan; the subagent plans via `/new-feat`.

### Step 2 — Prep the worktree + branch (`/new-feat` Agent 1A)

```bash
git -C /Users/ac/.work/osn.git fetch origin main
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> -b feat/<kebab-name> origin/main
# bun install in the new worktree (fresh worktrees have no node_modules)
(cd /Users/ac/.work/osn.git/<dir> && bun install)
```

Branch = `feat/<kebab>`; worktree dir = the name without the `feat/` prefix. "If needed" — skip only when the task genuinely continues an existing, unmerged branch.

### Step 3 — Hand the task off **totally** to a subagent

Dispatch ONE `general-purpose` subagent that **owns planning + implementation**. Give it: the task, the **gathered context** (Step 1), the worktree path + branch, and explicit instructions to:

- **Invoke the `/new-feat` skill** and follow it (it routes to the right sub-skills — frontend-design, cloudflare, TDD, etc. — see the skills table in `new-feat.md`). Plan the implementation itself; do not wait for a plan from you.
- Match repo conventions (root + area `CLAUDE.md`), add the required **changeset**, follow the observability rules, write tests (TDD where there's logic).
- **Commit on the branch; do NOT push and do NOT open a PR** — `/prep-pr` (Step 4) owns PR creation.
- **If it hits a decision it cannot resolve** from the context + sensible defaults, **STOP and return `NEEDS INPUT: <question> + options + your recommendation`** in its final report rather than guessing — you will answer or escalate (see "Handling subagent questions").

Do not re-implement or second-guess its design; let it work. Its final message is a report, not user-facing.

### Step 4 — `/prep-pr` (drive it; FIX findings, don't just report)

Run the `/prep-pr` flow on the branch. Beyond its standard steps (validate the changeset against the affected packages, build + tests, the `review-tests` pass, and the parallel **performance + security reviews**), this skill's contract is stronger: **after the reviews, dispatch fix-subagents to add the missing tests and fix every security and performance finding** (Critical/High/Medium at minimum; apply Low/Info when cheap), then re-verify. Carry forward any finding you deliberately defer as a tracked follow-up in the PR body. Scale review depth to the change (a docs/config PR doesn't need three review agents; an auth/route/binding change does). Then write the structured PR body (Summary / Workspaces / four-field Decisions & issues incl. each finding's disposition / Test plan) and **push + open the PR**.

### Step 5 — Watch the PR + squash-merge (or resolve conflicts)

Poll until terminal, then merge:

```bash
gh pr ready <n>            # if it was opened as a draft — THEN wait before polling (see gotcha)
gh pr view <n> --json mergeStateStatus,statusCheckRollup,state
```

- **All checks green + `mergeStateStatus: CLEAN`** → `gh pr merge <n> --squash --delete-branch`.
- **`mergeStateStatus: DIRTY`/`BEHIND` (conflicts / behind main)** → rebase the branch onto the latest `origin/main`, **resolve the conflicts** (sibling PRs that merged first are usually additive — keep both sides; for changeset/version churn from the release workflow, take the regenerated state), re-run the touched package's tests, force-push (`--force-with-lease --no-verify`), and re-poll.
- **A real check failure** → read the failing job, dispatch a fix-subagent, push, re-poll. Don't merge red.
- After merge, **remove the worktree** (`git worktree remove --force <dir>`) and delete the local branch.

### Between dependent tasks

After a merge, `git fetch origin main` + fast-forward local main so the next task's worktree is cut from the updated main. If a later task's branch already exists and now conflicts, rebase it onto the new main before its Step 5.

---

## Handling subagent questions / escalation

Subagents cannot prompt the user — they surface `NEEDS INPUT` in their report. When that happens:

1. **Try to answer it yourself** from the task, the codebase, repo conventions, prior decisions this session, and sensible defaults. If you can, reply by continuing that agent (`SendMessage` to its id) or by dispatching the next step with the decision baked in.
2. **Escalate to the human only when it's genuinely their call** — a product/scope choice, a value only they hold (real domains, account IDs, legal/copy), spend, or anything outward-facing/irreversible. Ask concisely (use `AskUserQuestion` for clear options), then feed the answer back to the subagent.
3. Don't let a subagent block silently or guess on a consequential decision — resolve or escalate.

---

## Gotchas (learned the hard way — encode these in your steps)

| Gotcha | Do this |
|--------|---------|
| `gh pr ready <n>` doesn't propagate instantly — a still-draft PR shows `mergeStateStatus: BLOCKED` even with all checks green | `gh pr ready` **then `sleep ~5–10s`** before reading `mergeStateStatus`; don't treat BLOCKED-on-draft as a CI failure |
| Pre-push lefthook runs `bun audit`, which fails on pre-existing transitive advisories and blocks the push | push with `--no-verify` (CI re-runs lint/test/typecheck — that's the real gate) |
| `scripts/validate-changesets.sh` uses `mapfile` (bash 4+); local macOS bash is 3.2 | don't rely on running it locally — CI (ubuntu) validates; just match the existing changeset format |
| Changesets: `@cire/*` are version-less (ignored); never mix ignored + versioned in one changeset; docs/CI-only PRs use an **empty** changeset (`---\n---` + summary) | name only the right packages; split if mixed |
| Wrangler **named environments do NOT inherit top-level bindings** (`[[d1_databases]]`, `[[r2_buckets]]`, `[[unsafe.bindings]]`, `[images]`) | mirror every binding into `[env.production]` (and dev/staging); verify with `wrangler deploy --dry-run` |
| The Bash tool's shell is **fish**, and bare `git` may not be on PATH | wrap bash-isms in `bash -c '...'`; call `/usr/bin/git` |
| Fresh worktrees have **no `node_modules`** | the subagent must `bun install` at the worktree root before running tests |
| LSP diagnostics in a worktree are often **stale/wrong** (no node_modules → bad type resolution) | trust the real `bun test` / `tsc --noEmit` / `wrangler dry-run` over streamed diagnostics |
| Merging many PRs in sequence: the release workflow auto-versions on each merge, and sibling PRs touching the same file (e.g. `wrangler.toml`, an entry `index.ts`) conflict | merge in dependency order; rebase + resolve additively as you go |

---

## When NOT to use `/orchestrate`

- A trivial one-line / single-file change — just edit it and open a PR directly.
- You're not in the bare-repo root (use `/new-feat` + `/prep-pr` in place).
- The task needs product/design direction first — `/brainstorm` with the user, then orchestrate the agreed scope.

When all tasks are merged, summarise: each PR (number + one line), anything deferred as a tracked follow-up, and any deploy-time / human actions surfaced by the subagents.
