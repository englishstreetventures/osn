#!/usr/bin/env bash
# Make the `/account` routes and their tests a reviewable branch diff.
#
# `src/lib/caller.ts` and `tests/lib/caller.test.ts` stay on the base on
# purpose. The resolver is where the route's two credentials are declared, and
# a reviewer should be able to read it without it being part of the diff. What
# is on trial is whether the audit notices which of the two the ROUTE tests
# exercise.
#
# The ground truth is in `graders/` and is not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 4b503fd0f8215c2813a1231c1b9893e71320f35f
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

ACCOUNT_PATHS=(
  pulse/api/src/routes/account.ts
  pulse/api/tests/routes/account.test.ts
)

git checkout -q -B main
git rm -rq "${ACCOUNT_PATHS[@]}"
git commit -qm "base: pulse /account routes not yet added"

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/pulse-account-routes
git revert --no-edit --no-commit HEAD

# The branch changes package source, so it needs a changeset naming the package
# it changes. Without one a missing changeset is a legitimate finding and would
# crowd out the test audit this scenario is measuring.
mkdir -p .changeset
cat > .changeset/pulse-account-routes.md <<'CHANGESET'
---
"@pulse/api": minor
---

Add the `/account` route group — deletion, restore and deletion status — with
route-level tests.
CHANGESET

git add -A
git commit -qm "feat(pulse-api): /account deletion, restore and status routes"

git config branch.feat/pulse-account-routes.gh-merge-base main
