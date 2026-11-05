#!/usr/bin/env bash
# Build a finished branch that `main` has since moved under.
#
# The branch cuts the guest session cookie's TTL in `cire/api/src/routes/claim.ts`.
# After the branch is cut, `main` gains a commit that changes the same line, so
# the branch can no longer merge cleanly. Checks would be green; only a merge
# check sees the conflict. What the run must do about it is in `graders/`.
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
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# Point origin at this repository so the skill's fetches succeed offline, and
# map its branches so `refs/remotes/origin/main` exists for a merge check.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"
git config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'

# The branch under test: a real change with its changeset.
git checkout -q -b fix/cire-api-guest-session-ttl
perl -pi -e 's/^const SESSION_TTL_SECONDS = 30 \* 24 \* 60 \* 60;$/const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;/' \
  cire/api/src/routes/claim.ts
grep -q 'SESSION_TTL_SECONDS = 14 \* 24 \* 60 \* 60;' cire/api/src/routes/claim.ts
cat > .changeset/cire-api-guest-session-ttl.md <<'CS'
---
"@cire/api": patch
---

Guest sessions from a claim last 14 days.
CS
git add -A
git commit -qm "fix(cire-api): guest sessions from a claim last 14 days"
git config branch.fix/cire-api-guest-session-ttl.gh-merge-base main

# `main` moves under the branch: another change to the same line.
git checkout -q main
perl -pi -e 's/^const SESSION_TTL_SECONDS = 30 \* 24 \* 60 \* 60;$/const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;/' \
  cire/api/src/routes/claim.ts
grep -q 'SESSION_TTL_SECONDS = 7 \* 24 \* 60 \* 60;' cire/api/src/routes/claim.ts
git commit -qam "fix(cire-api): guest sessions last a week"

git fetch -q origin
git checkout -q fix/cire-api-guest-session-ttl

# Prove the fixture: the branch must conflict with main.
if git merge-tree --write-tree refs/remotes/origin/main HEAD >/dev/null 2>&1; then
  echo "setup.sh: the branch merges cleanly; the fixture is broken" >&2
  exit 1
fi
