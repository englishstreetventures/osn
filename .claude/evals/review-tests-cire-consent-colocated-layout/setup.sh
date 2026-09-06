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
# The ground truth is in `criteria.json` and is not repeated here: this script
# runs inside the checkout the agent then reviews.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test, including the whole report specification. `exclude` in
# scenario.json does not actually strip them, so the baseline would read the
# very content the eval withholds. Delete every copy. The plugin variant
# supplies `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`. Normalise that, and
# fold any install-time drift into history BEFORE branching so it lands on the
# base and never appears as part of the branch under review.
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
