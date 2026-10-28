#!/usr/bin/env bash
# Make the shared token verifier a reviewable branch diff.
#
# The fixture tree already contains `@shared/osn-auth-client`, so
# `git diff main...HEAD` would be empty. Construct a base where the package is
# absent and a feature branch that adds it back, which makes the package itself
# the branch's diff — the review surface the skill expects.
#
# What is wrong with the code, and what is deliberately right about it, is in
# `graders/` and is not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 970f06c6076db9c424bc8b5dccafb1cb46df17c2
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main
git rm -rq shared/osn-auth-client
git commit -qm "base: shared osn auth client not yet added"

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/shared-osn-auth-client
git revert --no-edit --no-commit HEAD

# The package's own CHANGELOG is the one file that gives the game away: it is a
# release history for a package the branch presents as new, and its entries name
# the findings already fixed here. Drop it rather than leave an inconsistency an
# agent would stop to explain.
rm -f shared/osn-auth-client/CHANGELOG.md

git add -A
git commit -qm "feat(shared): shared OSN access-token verifier for downstream services"

git config branch.feat/shared-osn-auth-client.gh-merge-base main
