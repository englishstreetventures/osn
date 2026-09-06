---
name: new-feat
description: Use when starting a piece of feature or fix work in this repository — taking or opening its GitHub issue, cutting the branch (a worktree on the local bare repo, an in-place branch on the remote environment) and producing the implementation plan, including the wiki pages the work will make stale and its observability plan. Also the step for turning a tracker finding into a branch without publishing it.
---

Start new work for `$ARGUMENTS`. If it is empty, ask for a feature name, an issue number, or a finding before doing anything.

## What this run must produce

Three things, in this order — each depends on the one before:

1. **The issue.** Taken by number when one exists, opened otherwise. The branch name is derived from its title, so nothing else can happen first.
2. **The branch.** A worktree on the local bare repo, or an in-place branch on the remote environment — Step 1 decides which.
3. **The plan.** Files, steps, the wiki pages the work makes stale, the changeset, and the observability plan.

Report all three in the final message: issue number and its project status, branch name (and worktree path), the plan. In a non-interactive run — no user reading the chat — write the same three things to `NEW-FEAT.md` at the root of the checkout, or to whichever file the task named. It is scratch, never committed.

## When a gate cannot run

**Find out once, before Step 0**, rather than failing each step in turn:

```bash
command -v gh >/dev/null && gh auth status >/dev/null 2>&1 && echo "gh: yes" || echo "gh: no"
[ -d /Users/ac/.work/osn.git ] && [ "$(uname)" = "Darwin" ] && echo PERSONAL || echo REMOTE
```

No `gh` or no network: the issue step's static form is the issue you *would* file — title, type, label, four-field body — written into the report, and the branch still gets a name derived from that title. Never describe an issue as opened, moved or labelled when the command could not run. No user to answer a question: take the conservative default the step names, record it, continue. Nothing here is a stop.

## Step 0 — The issue comes first

Every branch traces to an issue, so the work is visible before it starts.

**Take an existing issue** when `$ARGUMENTS` is a number or URL (`#412`, `xchromo/osn#412`):

```bash
gh issue view 412 --repo xchromo/osn --json number,title,body,labels
```

**A review finding is the exception that already has an issue.** An `S-`, `P-` or `C-` ID, or an `osn-tracker#` reference, names an issue in the private `xchromo/osn-tracker`. Take it by number there. Do not open a duplicate in the public repo, and **keep the finding's text out of the branch name** — `xchromo/osn` is public and its branch list is visible, so `fix/timing-oracle-in-claim-compare` publishes the defect before the fix lands. Name the branch after the area or the tracker number: `fix/cire-api-claim-hardening`, `fix/tracker-601`. The same rule covers the plan file and every commit message on the branch.

**Otherwise open one:**

```bash
gh issue create --repo xchromo/osn \
  --title "<short imperative title>" \
  --type Feature \
  --label "product:<osn-core|pulse|cire|zap|shared|landing>" \
  --body-file <(cat <<'BODY'
**What** — the change, in two or three sentences. Name the surface it lands on.

**Why** — what is wrong or missing today, and who feels it.

**Done when** — the observable result. Not "implemented"; the thing a reviewer can check.

**Notes** — constraints, the files or systems it touches, anything already decided. Wiki pages by repo path (`wiki/systems/rate-limiting.md`), and the fact they carry restated here — a `[[wikilink]]` does not resolve on GitHub.
BODY
)
```

The body stands on its own: someone opening it months later with nothing checked out sees what to build and how to know it is done. Never a body that only points elsewhere — "see the TODO", "per `wiki/todo/web.md`". Pages move; the issue is the record.

`--type` is an org-level field, separate from the labels: `Feature` for new capability, `Bug` for something built that behaves wrongly, `Task` for the rest — a migration, a chore, infrastructure. Exactly one `product:` label. No `area:` unless the work is a finding or is `ops`, `schema` or `docs`; there is no `area:feature`.

Then two things follow from the issue:

- **The branch name** — kebab-case the title, prefix it: `feat/` for a Feature, `fix/` for a Bug, `chore/`, `refactor/` or `docs/` for a Task. Step 1 uses this name; it does not derive its own.
- **Status** — move the issue to **In Progress** in the **OSN Platform** project. `gh project item-edit` needs the `project` scope; if it is missing, say so and move it in the UI rather than skipping it.

## Step 1 — The branch

The probe above said `PERSONAL` or `REMOTE`. They differ in one thing: whether there is a bare repo to add a worktree to.

**PERSONAL** — the bare repo at `/Users/ac/.work/osn.git`. Every piece of work gets its own worktree; never check the branch out inside an existing one (`main/` included) — that mutates its state.

```bash
git -C /Users/ac/.work/osn.git fetch origin main
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> -b <branch> origin/main
(cd /Users/ac/.work/osn.git/<dir> && bun install)      # a fresh worktree has no node_modules
```

`<dir>` is the branch name without its prefix. If the work **stacks on another open PR's branch**, cut from that branch instead of `origin/main` and record the base, or `prep-pr` opens the PR against `main`:

```bash
git -C /Users/ac/.work/osn.git worktree add /Users/ac/.work/osn.git/<dir> -b <branch> <parent-branch>
git -C /Users/ac/.work/osn.git/<dir> config branch.<branch>.gh-merge-base <parent-branch>
```

Report the branch, its base and the worktree path. **All work happens in that worktree**, so `cd` into it before anything else.

**REMOTE** — the repository is already checked out in the working directory with `node_modules` installed. No worktree, no second `bun install`.

```bash
git fetch origin main
git checkout -B <branch> origin/main
```

If the session was given a **designated `claude/*` branch**, use that exact name instead of the one from Step 0 and never push to any other. `-B` makes a re-run idempotent; with uncommitted work in progress, switch without resetting.

## Step 2 — The plan

Explore and plan; do not implement yet. Dispatch a `Plan` subagent when one is available, otherwise do it inline.

**Start in the wiki, not the source.** The systems the work touches have pages holding their contract, finding history and observability — cheaper to read than to reconstruct from code. Follow the three-tier ladder in `CLAUDE.md` §Searching the wiki (Obsidian MCP when present, else the `obsidian` CLI, else grep), then open the source to confirm what the pages claim.

The plan names:

- the existing files and patterns in play — Effect services, Elysia routes, Drizzle schema, SolidJS components — and the reference implementation elsewhere in the repo to copy from
- the files to create or modify, and the steps in order
- **the wiki pages this work makes stale, by repo path** — `prep-pr` has to update every one, and finding them now is cheaper than at PR time
- Effect, WebSocket or E2E-encryption considerations, if any
- the changeset — always needed unless every changed file is on the allowlist in `scripts/changeset-required.sh`; `@cire/*` packages are version-less and never share a changeset with a versioned one
- **the observability plan** for every new service, route or service function — which error paths use `Effect.logError` and any new secret field for the redaction list; which functions get `Effect.withSpan("<domain>.<operation>")` and that outbound HTTP goes through `instrumentedFetch`; which counters or histograms join the owning `metrics.ts`, named `{namespace}.{domain}.{subject}.{measurement}` with a bounded string-literal attribute type — never a user, request or event id. `wiki/observability/overview.md` holds the rules.

While implementing, invoke the skill that already encodes the sub-task — UI, Cloudflare, TDD, debugging, brainstorming when scope is open, Obsidian syntax for any wiki edit. The routing table is `references/skills-routing.md`; when unsure whether one fits, invoke it — a wrong fit costs little.

## Finish

Summarise the issue and its status, the branch (and worktree path), and the plan. On PERSONAL, `cd` into the worktree before any implementation starts. When the user is happy with the implementation, prompt: "Ready to prepare this branch for a PR? Run `/prep-pr` to validate changesets, run tests, get performance and security reviews, and push the branch."
