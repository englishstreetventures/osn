#!/usr/bin/env bash
# Make the shared token verifier a reviewable branch diff.
#
# The fixture tree already contains `@shared/osn-auth-client`, so
# `git diff main...HEAD` would be empty. Construct a base where the package is
# absent and a feature branch that adds it back, which makes the package itself
# the branch's diff — the review surface the skill expects.
#
# What is wrong with the code, and what is deliberately right about it, is in
# `criteria.json`. It is not repeated here: this script runs inside the
# checkout the agent then reviews.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test, including the whole review report specification. `exclude`
# in scenario.json does not actually strip them, so the baseline would be
# reading the very content the eval withholds. Delete every copy. The plugin
# variant supplies `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`. Normalise that: make
# sure there is a repository, and fold any install-time drift into history
# BEFORE branching, so it lands on the base and never appears as part of the
# branch under review.
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
