#!/usr/bin/env bash
# Make the chat and message services a reviewable branch diff.
#
# The fixture tree already contains these files, so `git diff main...HEAD`
# would be empty. Construct a base where they are absent and a branch that adds
# them back, which makes the services themselves the branch's diff.
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
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git b7dcdbd4649c85768c5fa2c8e470e7cf7ded61a8
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

# `routes/internal.ts` and its test stay on the base on purpose: the gated
# reader is the context that makes the missing check a finding, and a reviewer
# should be able to read it without it being part of the diff.
#
# The three service and route tests stay on the base for a different reason.
# They are 1771 of the 3196 lines these paths hold, and both review skills
# require every changed file to be read in full and given a Coverage line — so
# in the diff they are mandated reading that no checklist item scores. On the
# base they are still there to be read, and the diff is the three files the
# finding actually lives in.
CHAT_PATHS=(
  zap/api/src/services/chats.ts
  zap/api/src/services/messages.ts
  zap/api/src/routes/chats.ts
)

git checkout -q -B main
git rm -rq "${CHAT_PATHS[@]}"
git commit -qm "base: zap consumer chat service not yet added"

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/zap-consumer-chat-service
git revert --no-edit --no-commit HEAD
git add -A
git commit -qm "feat(zap): consumer chat and message services with their routes"

git config branch.feat/zap-consumer-chat-service.gh-merge-base main
