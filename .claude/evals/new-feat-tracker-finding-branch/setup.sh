#!/usr/bin/env bash
# Leave the checkout on `main` with a remote that resolves, so the agent can
# cut its own branch from `origin/main` the way the procedure under test says
# to. No branch is built here: creating one is part of the exercise.
#
# What the task's finding is about, and what the plan should name, are in
# `graders/` and are deliberately not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 536fba000094544bc808e0a57378b4418622dc06
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# The agent's shell runs sandboxed, and the sandbox will not let it write
# `.git/config`. A branch cut from `origin/main` would try to record its
# upstream there, so do not record one.
git config branch.autoSetupMerge false

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# The procedure opens with `git fetch origin main` and cuts the branch from
# `origin/main`. Point origin at this repository so both succeed, and fetch
# once so the remote-tracking ref exists before the agent starts.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"
git fetch -q origin main
