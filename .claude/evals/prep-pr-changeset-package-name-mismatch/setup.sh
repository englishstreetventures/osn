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
# What is actually wrong, and what the correct answer is, lives in
# `criteria.json` and is not repeated here: this script runs inside the
# checkout the agent then works in.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test, including the whole five-section PR-body specification.
# `exclude` in scenario.json does not actually strip them, so the baseline was
# reading the very content the eval withholds. Delete every copy. The plugin
# variant supplies `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`, and may drop paths
# named in the fixture `exclude` list. Normalise both: make sure there is a
# repository, and fold any install-time drift into history BEFORE branching, so
# it lands on the base and never appears as part of the branch under review.
if [ ! -d .git ]; then
  git init -q
  git config user.email "eval@example.invalid"
  git config user.name "Tessl Eval"
fi

# The harness injects the plugin as symlinks under `.claude/` and `.agents/`,
# and only into the with-context variant. Left visible they show up as working
# -tree changes in that variant alone, which the no-source-edits check then
# scores against it. Ignore them in both variants so the guard measures the
# agent, not the harness.
mkdir -p .git/info
printf '.claude/\n.agents/\n' >> .git/info/exclude

git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# The skill's step 0 opens with `git fetch origin "$BASE"`. Without a remote
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
cat > .changeset/tessl-eval-fixture.md <<'CS'
---
"osn-api": patch
---

Tighten the refresh-token rotation grace window from 10s to 5s.
CS
git add -A
git commit -qm "fix(osn-api): tighten refresh rotation grace window"

git config branch.fix/osn-api-refresh-window.gh-merge-base feat/osn-api-session-labels
