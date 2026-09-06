#!/usr/bin/env bash
# Make the consent framework a reviewable branch diff.
#
# The fixture tree already contains the module, so `git diff main...HEAD` would
# be empty. Construct a base where it is absent and a feature branch that adds
# it back, which makes the module itself the branch's diff — the review surface
# the skill expects.
#
# The ground truth, including the one piece of deliberate bait, is in
# `criteria.json` and is not repeated here: this script runs inside the
# checkout the agent then reviews.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test, including the whole five-section PR-body specification.
# `exclude` in scenario.json does not actually strip them, so the baseline was
# reading the very content the eval withholds. Delete every copy. The plugin
# variant supplies `.claude/skills/`, which nothing here touches.
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
