#!/usr/bin/env bash
# Build a STACKED branch under test.
#
# `fix/osn-api-refresh-window` sits on top of `feat/osn-api-session-labels`,
# not on main, and `gh-merge-base` records that. The parent carries a commit
# and a changeset of its own, so an agent that assumes main inherits both.
#
# The branch's own changeset names a package deliberately: `osn-api` rather
# than `osn`, because the ROOT package.json really is named `osn` and that
# spelling would give a sharp agent something true to argue. The check wants
# one unambiguous answer.
#
# What is actually wrong, and what the correct answer is, lives in `graders/`
# and is not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git ebbef4c45e5eebaac499804755b8f3c802bac79b
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# The skill's step 0 opens by fetching the base branch. Without a remote
# that fails every run, costing turns and inviting a rabbit hole. Point origin
# at this repository so the fetch is a no-op that succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

# The parent PR in the stack — already open, already has its own changeset.
git checkout -q -b feat/osn-api-session-labels
printf '\n// parent branch: coarse UA labels on session rows\n' >> osn/api/src/metrics.ts
cat > .changeset/parent-session-labels.md <<'CS'
---
"@osn/api": minor
---

Coarse UA labels on session rows.
CS
git add -A
git commit -qm "feat(osn-api): coarse UA labels on session rows"

# This branch, stacked on top of it. The diff is a real change to the constant
# the commit message and changeset both describe, so nothing about the branch
# is internally inconsistent except the planted package name.
git checkout -q -b fix/osn-api-refresh-window
perl -pi -e 's/^export const ROTATION_GRACE_MS = 10_000;$/export const ROTATION_GRACE_MS = 5_000;/' \
  osn/api/src/services/auth/constants.ts
grep -q 'ROTATION_GRACE_MS = 5_000;' osn/api/src/services/auth/constants.ts
cat > .changeset/osn-api-refresh-window.md <<'CS'
---
"osn-api": patch
---

Tighten the refresh-token rotation grace window from 10s to 5s.
CS
git add -A
git commit -qm "fix(osn-api): tighten refresh rotation grace window"

git config branch.fix/osn-api-refresh-window.gh-merge-base feat/osn-api-session-labels
