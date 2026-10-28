#!/usr/bin/env bash
# Make the consent framework a reviewable branch diff.
#
# The fixture tree already contains the module, so `git diff main...HEAD` would
# be empty. Construct a base where it is absent and a feature branch that adds
# it back, which makes the module itself the branch's diff — the review surface
# the skill expects.
#
# The ground truth, including the one piece of deliberate bait, is in
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
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 339ec85aebf6d41b4a2c11fb034c29ec6c6d1fb4
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

# The nine source modules, named one by one rather than by directory, so the
# five co-located test files stay on the base branch. Those tests are 1117 of
# the 2544 lines these directories hold, and the review skill requires every
# changed file to be read in full and given a Coverage line — so in the diff
# they are mandated reading that no checklist item scores. On the base they are
# still there to be read.
CONSENT_PATHS=(
  cire/invites/src/lib/consent/categories.ts
  cire/invites/src/lib/consent/cookie.ts
  cire/invites/src/lib/consent/record.ts
  cire/invites/src/lib/consent/store.ts
  cire/invites/src/lib/consent/testing.ts
  cire/invites/src/lib/consent/vendors.ts
  cire/invites/src/components/consent/ConsentBanner.tsx
  cire/invites/src/components/consent/ConsentGate.tsx
  cire/invites/src/components/consent/ConsentPreferences.tsx
)

git checkout -q -B main
git rm -rq "${CONSENT_PATHS[@]}"
git commit -qm "base: cire consent framework not yet added"

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/cire-consent-framework
git revert --no-edit --no-commit HEAD

# Bait for the no-semver-range check. The consent dialog animates, so the
# branch bumping its animation library's caret range is ordinary. A review that
# reports a caret or `^` range as a supply-chain finding has invented a problem
# the repo does not have: ranges are what this monorepo uses everywhere, and
# `minimumReleaseAge` in bunfig.toml is the actual control against a hostile
# publish. The check tests that the reviewer knows the difference.
perl -pi -e 's/"motion": "\^12\.42\.2"/"motion": "^12.44.0"/' cire/invites/package.json
grep -q '"motion": "\^12.44.0"' cire/invites/package.json

git add -A
git commit -qm "feat(cire): site-wide cookie and third-party consent framework"

git config branch.feat/cire-consent-framework.gh-merge-base main
