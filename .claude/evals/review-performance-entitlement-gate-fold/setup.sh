#!/usr/bin/env bash
# Make the organiser role gates and the entitlement gate a reviewable branch
# diff.
#
# The fixture tree already contains these files, so `git diff main...HEAD`
# would be empty. Construct a base where they are absent and a branch that adds
# them back, which makes the gates the branch's own diff.
#
# `services/directory.ts` and the three routes that pass an entitlement key
# stay on the base on purpose. They are how a reviewer sees the existing idiom
# and counts the callers a fix would affect, and they should be readable
# without being part of the diff.
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
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 536fba000094544bc808e0a57378b4418622dc06
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

# The route files that mount these gates stay on the base on purpose. They are
# what makes the shared-middleware question answerable — a reviewer can count
# how many routes mount a role gate without an entitlement gate — and they
# should be readable without being part of the diff.
# The three gates and the service holding the query they would fold into. The
# entitlement service and every co-located test stay on the base: they are
# context a reviewer can open, and this scenario asks nothing about them, so
# putting them in the diff buys turns and tokens and no signal.
GATE_PATHS=(
  cire/api/src/middleware/wedding-member.ts
  cire/api/src/middleware/wedding-editor.ts
  cire/api/src/middleware/wedding-entitlement.ts
  cire/api/src/services/hosts.ts
)

git checkout -q -B main
git rm -rq "${GATE_PATHS[@]}"
git commit -qm "base: organiser wedding gates not yet added"

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/cire-wedding-gates
git revert --no-edit --no-commit HEAD

# The branch changes package source, so it needs a changeset naming the package
# it changes. Without one a missing changeset is a legitimate finding and would
# crowd out the performance review this scenario is measuring.
mkdir -p .changeset
cat > .changeset/cire-wedding-gates.md <<'CHANGESET'
---
"@cire/api": minor
---

Add the organiser role gates and the paid-feature entitlement gate for
`/api/organiser/weddings/:weddingId/*`, with the host and entitlement services
behind them.
CHANGESET

git add -A
git commit -qm "feat(cire-api): organiser role gates and the entitlement gate"

git config branch.feat/cire-wedding-gates.gh-merge-base main
