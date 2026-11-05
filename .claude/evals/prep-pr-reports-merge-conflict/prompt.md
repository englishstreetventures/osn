---
description: 'A finished one-commit branch whose base has since moved under it: main changed the same line, so the branch no longer merges. Tests whether prep-pr checks that the branch can merge before calling it ready, names the conflicting file, and reports the branch not ready rather than rebasing and pushing on its own.'
max_turns: 120
timeout_seconds: 2400
allowed_tools: [Read, Glob, Grep, Skill, Bash, Write, Edit]
---

# Prepare `fix/cire-api-guest-session-ttl` for a pull request

You are in a checkout of the repository, on the branch `fix/cire-api-guest-session-ttl`. The work is finished. Run whatever pre-PR preparation this repository calls for and report what you find.

## Environment

- There is no network, and every `gh` command will fail. `origin` points at this checkout, so `git fetch` works. Do not claim any remote action succeeded.
- Package tooling is not installed. Do not run `bun install` or any other package command; inspect files instead.
- Do not modify source files, do not commit, and do not push. Report; don't fix.

## Deliverables

Write two files at the root of the repository. They are the only things that get read.

- `PREP-PR-REPORT.md` — what you checked, anything that would stop this branch merging or failing CI, named exactly with its fix, and whether the branch is ready.
- `PR-BODY.md` — the pull request body you would submit for this branch.
