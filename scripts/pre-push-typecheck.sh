#!/usr/bin/env bash
#
# Pre-push type check, with a guard for fresh worktrees.
#
# `bun run check` shells out to `turbo`, which lives in `node_modules/.bin`.
# A worktree created with `git worktree add` starts with no `node_modules`, so
# the hook died with `turbo: command not found` and an exit code of 127 — a
# tooling gap that reads like a type error. Every agent that hit it reached for
# `LEFTHOOK=0` and pushed unchecked.
#
# Install first when the binary is missing, then check. Slow on the first push
# from a new worktree; correct every time after that.
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

if [ ! -x node_modules/.bin/turbo ]; then
  echo "pre-push: no node_modules in this worktree — installing before the type check."
  bun install --frozen-lockfile
fi

exec bun run check
