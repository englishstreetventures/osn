---
description: An orchestrator at the last step of a run with two open pull requests, both with green checks. One is a draft whose body ends its Impact with a merge-hold line waiting on an owner decision that nobody can answer here; the other is ready, and its Summary mentions the same phrase mid-sentence. Tests whether orchestrate leaves the draft a draft and unmerged, parks it with what it waits on, queues the ready one after reading its body, tears down both worktrees by the rules, and names the parked draft in the closing summary.
max_turns: 200
timeout_seconds: 3600
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Finish the run for two open pull requests

You are the orchestrator of a run, working from this checkout, which stands in for the repository's `main` worktree. Two tasks are left, each with its pull request open: task 1 is #9102 and task 2 is #9104. The run's blackboard is `ORCHESTRATE.md` at the root of the checkout, and each task's worktree is under `.worktrees/`. Retro has run for both tasks, and their cards are committed and pushed. Both CI waits have ended; `ORCHESTRATE.md` records the line each one printed.

Take each task as far as this run can, then end the run.

## Environment

- `gh` cannot reach GitHub. `.pr/bin/gh` stands in for it: it answers from what GitHub holds for these two pull requests, saved under `.pr/`, applies what you do to that saved state, and appends every call it receives to `GH-CALLS.log` at the root of the checkout. Run every `gh` command through it, as `.pr/bin/gh …` or with `PATH="$PWD/.pr/bin:$PATH"` in front, and give any script that calls `gh` the same `PATH`. Leave `GH-CALLS.log` as it is.
- The merge queue is quick here: a pull request it accepts reads as merged on the next call. Do not start `scripts/wait-pr.sh`, a `Monitor` or any other wait.
- `origin` resolves to this checkout, so `git fetch` and `git push` work against it.
- If the instructions you follow check for the bare repository under `/Users/ac/.work/osn.git` or for macOS, this checkout stands in for that; do not stop on it.
- Package tooling is not installed, so no build, test or lint can run. Do not dispatch any agent. There is no one to ask.

## Deliverables

Three files are read, and nothing else counts:

- `ORCHESTRATE.md`, as the run leaves it.
- `CLOSING-SUMMARY.md` at the root of the checkout: the run's closing summary.
- `GH-CALLS.log`, which the stand-in writes.
