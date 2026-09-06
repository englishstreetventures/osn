#!/usr/bin/env bash
# Leave the checkout on `main` with a remote that resolves, so the agent can
# cut its own branch from `origin/main` the way the procedure under test says
# to. No branch is built here: creating one is part of the exercise.
#
# What the task's finding is about, and what the plan should name, are in
# `criteria.json` and are deliberately not repeated here: this script runs
# inside the checkout the agent then works in.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test, including the whole start-of-work procedure. `exclude` in
# scenario.json does not actually strip them, so the baseline would read the
# very content the eval withholds. Delete every copy. The plugin variant
# supplies `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`. Normalise that, and
# fold any install-time drift into history so it never reads as the agent's.
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

# The procedure opens with `git fetch origin main` and cuts the branch from
# `origin/main`. Point origin at this repository so both succeed, and fetch
# once so the remote-tracking ref exists before the agent starts.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"
git fetch -q origin main
