#!/usr/bin/env bash
# Make the vendor read paths a reviewable branch diff.
#
# The fixture tree already contains these files, so `git diff main...HEAD`
# would be empty. Construct a base where they are absent and a branch that adds
# them back, which makes the four read paths the branch's own diff.
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
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git f4e345e57b28de6a25355b7b7732135d9ca7bfa6
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
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
