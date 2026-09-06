#!/usr/bin/env bash
# Make the chat and message services a reviewable branch diff.
#
# The fixture tree already contains these files, so `git diff main...HEAD`
# would be empty. Construct a base where they are absent and a branch that adds
# them back, which makes the services themselves the branch's diff.
#
# The ground truth is in `criteria.json` and is not repeated here: this script
# runs inside the checkout the agent then reviews.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test, including the whole report specification. `exclude` in
# scenario.json does not actually strip them, so the baseline was reading the
# very content the eval withholds. Delete every copy. The plugin variant
# supplies `.claude/skills/`, which nothing here touches.
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
