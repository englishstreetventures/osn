#!/usr/bin/env bash
# tools/oxlint/anti-slop is excluded from oxfmt and ignored by oxlint (see its
# README), specifically so a re-vendor stays a plain copy with no formatting
# noise. That also means an edit to the vendored tree passes every other gate
# unnoticed — this is the one check that would catch it.
#
# `shasum -c` only verifies the paths SHA256SUMS lists — a file ADDED to the
# tree isn't in that list, so it has nothing to check it against and passes
# silently. The diff catches that half: it fails if the tracked file set
# drifts from SHA256SUMS in either direction, added or removed.
#
# `git ls-files`, not `find`: it reads the tracked/staged set, which is what
# this check claims to cover; it lists symlinks (`find -type f` silently
# skips them); it needs no `sed` to strip a `./` prefix; and it works with no
# `bun install` — the CI callers run before or without one.
#
# The unsets matter. Git exports GIT_DIR (and friends) to its hooks, and in a
# linked worktree that value is an absolute path, so it still resolves after
# the `cd` below. `git ls-files` then treats the work tree root as the current
# directory, ignores the vendored subdirectory entirely, and lists all ~2300
# tracked files — the diff fails against a 21-line SHA256SUMS every time. Off
# the hook path the same command works, which is what makes it confusing. In
# the main checkout GIT_DIR is the relative `.git`, which stops resolving once
# we `cd`, so git rediscovers the repository from the current directory and
# the check passes; the bug only ever bites in a worktree.
set -euo pipefail
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

# Git exports GIT_DIR to every hook it runs, and with GIT_DIR set and no
# GIT_WORK_TREE, `git ls-files` bases itself on the work-tree root whatever the
# working directory is. Under lefthook's pre-commit that made the listing below
# return all ~1800 tracked files instead of the vendored subtree's dozen, so the
# diff failed and no commit touching a .js/.ts file could be made without
# LEFTHOOK=0. Clearing the inherited variables puts discovery back on the
# working directory, which is what every other git call here assumes.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

cd "$(dirname "$0")/.."

cd tools/oxlint/anti-slop
shasum -c SHA256SUMS
diff <(sed 's/^[0-9a-f]*  //' SHA256SUMS | sort) \
     <(git ls-files | grep -v '^SHA256SUMS$' | sort)
