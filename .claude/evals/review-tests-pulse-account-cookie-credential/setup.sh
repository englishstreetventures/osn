#!/usr/bin/env bash
# Make the `/account` routes and their tests a reviewable branch diff.
#
# `src/lib/caller.ts` and `tests/lib/caller.test.ts` stay on the base on
# purpose. The resolver is where the route's two credentials are declared, and
# a reviewer should be able to read it without it being part of the diff. What
# is on trial is whether the audit notices which of the two the ROUTE tests
# exercise.
#
# The ground truth is in `criteria.json` and is not repeated here: this script
# runs inside the checkout the agent then reviews.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test, including the whole report specification. `exclude` in
# scenario.json does not actually strip them, so the baseline would read the
# very content the eval withholds. Delete every copy. The plugin variant
# supplies `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`. Normalise that, and
# fold any install-time drift into history BEFORE branching so it lands on the
# base and never appears as part of the branch under review.
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
