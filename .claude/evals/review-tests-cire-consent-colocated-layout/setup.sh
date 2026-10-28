#!/usr/bin/env bash
# Make part of the consent framework a reviewable branch diff, in a package
# whose tests do not live where most of this repository's tests live.
#
# `cire/invites` has no `tests/` directory: its 69 test files sit beside the
# modules they cover. The eight paths below are chosen so that resolving that
# layout from disk is the whole exercise, and the rest of the consent module
# stays on the base branch — it is how a reviewer establishes the layout
# without it being part of the diff.
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

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

CONSENT_PATHS=(
  cire/invites/src/lib/consent/cookie.ts
  cire/invites/src/lib/consent/cookie.test.ts
  cire/invites/src/lib/consent/store.ts
  cire/invites/src/lib/consent/store.test.ts
  cire/invites/src/lib/consent/testing.ts
  cire/invites/src/components/consent/ConsentGate.tsx
  cire/invites/src/components/consent/ConsentGate.test.tsx
  cire/invites/src/components/consent/ConsentPreferences.tsx
)

git checkout -q -B main
git rm -rq "${CONSENT_PATHS[@]}"
git commit -qm "base: consent cookie, store, gate and preferences not yet added"

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/cire-consent-framework
git revert --no-edit --no-commit HEAD

# `@cire/*` packages are version-less and ignored by changesets, so this branch
# needs no changeset and an absent one is not a finding.

git add -A
git commit -qm "feat(cire): consent cookie and store layers, gate and preferences dialog"

git config branch.feat/cire-consent-framework.gh-merge-base main
