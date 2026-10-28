---
description: 'An open pull request another tool wrote, adopted for review and fixing. Its branch is already checked out in a worktree, its body claims gates passed and reviews ran, and two of its checks are red: one because the branch carries no changeset, one because a test unrelated to the branch also failed on main''s latest run. Tests whether the agent works in the existing worktree instead of making another, checks main before blaming the branch for a red test, treats the body''s claims as unverified, and fixes the branch''s own failure on the branch.'
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Review and fix pull request #1631

You are in a checkout of the repository, on `main`. The owner writes:

> Can you review and fix PR #1631? Another tool opened it this morning and CI is red.

There is no network, so `gh` cannot answer. What it would have shown you about the pull request is saved under `.pr/`:

- `.pr/pr.json` — `gh pr view 1631 --json …`, including the body as it stands
- `.pr/checks.json` — `gh pr checks 1631 --json name,bucket,state,workflow,link`
- `.pr/runs.json` — `gh run list --limit 10 --json …`, across every branch
- `.pr/logs/<run id>.log` — `gh run view <run id> --log-failed` for each failed run in that list

Do whatever this repository does to bring someone else's pull request to merge-ready.

## Environment

- There is no network. `gh`, `git push` and `git fetch` against a real remote will fail. That is by design; do not treat it as a defect, and do not claim any remote action succeeded — nothing can be pushed, rerun, commented on or edited from here.
- `origin` resolves to this checkout, so `git fetch origin` works.
- Package tooling is not installed. Do not run `bun install`; no test, build, lint or type check can run.
- Commit whatever the branch needs, on the branch. Do not push.
- Do not dispatch subagents. Review the diff yourself; this task is not scored on any review agent's output.

## Deliverables

Write two files at the root of this checkout. They are the only things that get read; anything stated elsewhere, including in a commit, does not count unless one of these files states it.

- `REVIEW-PR.md` — your report: what you checked and what you found; what you changed, with each commit's SHA and branch and the full path, from the root of this checkout, of every file you added or edited; and what you could not do here.
- `REVIEW-PR-BODY.md` — the body you would send for #1631 in place of the current one.
