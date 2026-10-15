#!/usr/bin/env bash
# Commits what .github/workflows/release.yml's release job changed and pushes
# it to the branch the checkout tracks. Run from the repository root by that
# job's "Commit and push if changed" step, after `git config user.name` and
# `user.email`; tested by scripts/tests/release-commit.test.sh.
#
# Stages only the paths the job writes: the version bumps from
# `bun run version` (package.json and CHANGELOG.md files, consumed changesets,
# bun.lock) and the lint-warning ceiling that
# `scripts/guard-lint-warnings.sh --lower-to` lowered. Exits 0 without a
# commit when none of them changed. The message says which of the two the
# commit holds.
#
# --no-verify on both commit and push: the lefthook pre-commit and pre-push
# hooks run `bun audit` and a type check, which fail on pre-existing
# transitive advisories and would abort this push on every merge. CI (Type
# Check, Build & Test) is the real gate; this commit carries generated
# version bumps and the ceiling's value line only.
#
# A push that loses a race to a newer commit on the remote fails, and the
# step with it; the next Release run versions and measures again.
set -euo pipefail

ceiling="scripts/lint-warning-ceiling.txt"

git add '**/package.json' '**/CHANGELOG.md' .changeset/ bun.lock "$ceiling"

if git diff --staged --quiet; then
  echo "Nothing to commit."
  exit 0
fi

if git diff --staged --quiet -- "$ceiling"; then
  message="chore: version packages"
elif git diff --staged --quiet -- ":(exclude)$ceiling"; then
  message="chore: lower the lint-warning ceiling"
else
  message="chore: version packages, lower the lint-warning ceiling"
fi

git commit --no-verify -m "$message"
git push --no-verify
