#!/usr/bin/env bash
# Make the vendor read paths a reviewable branch diff.
#
# The fixture tree already contains these files, so `git diff main...HEAD`
# would be empty. Construct a base where they are absent and a branch that adds
# them back, which makes the four read paths the branch's own diff.
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

# `routes/vendor-directory.ts` and the rest of the vendor portal stay on the
# base on purpose: they are the context that makes the read paths legible, and
# a reviewer should be able to open them without them being part of the diff.
# Only the four source files. Their co-located tests stay on the base: they are
# useful context and a reviewer can open them, but they are large and this
# scenario asks nothing about them, so putting them in the diff buys turns and
# tokens and no signal.
VENDOR_PATHS=(
  cire/api/src/routes/vendor-enquiries.ts
  cire/api/src/services/directory.ts
  cire/vendor/src/components/ClaimApp.tsx
  cire/vendor/src/components/ListingEditor.tsx
)

git checkout -q -B main
git rm -rq "${VENDOR_PATHS[@]}"
git commit -qm "base: vendor enquiry routes, directory service and portal screens not yet added"

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/cire-vendor-enquiries-and-directory
git revert --no-edit --no-commit HEAD

# The branch changes package source, so it needs a changeset naming the
# packages it changes. Without one a missing changeset is a legitimate finding
# and would crowd out the performance review this scenario is measuring.
mkdir -p .changeset
cat > .changeset/vendor-enquiries-and-directory.md <<'CHANGESET'
---
"@cire/api": minor
"@cire/vendor": minor
---

Add the vendor enquiry routes and the directory service, and the claim and
listing-editor screens of the vendor portal.
CHANGESET

git add -A
git commit -qm "feat(cire): vendor enquiry routes, directory service and portal screens"

git config branch.feat/cire-vendor-enquiries-and-directory.gh-merge-base main
