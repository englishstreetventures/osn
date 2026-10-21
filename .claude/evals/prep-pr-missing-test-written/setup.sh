#!/usr/bin/env bash
# Build a branch whose one new source module has no test file, and plant the
# test review's report of that gap.
#
# The branch adds `cire/api/src/lib/guest-note.ts` and nothing else that
# covers it. The untracked `REVIEW-TESTS.md` names the missing test and the
# cases it must assert. Which of the two paths the agent takes, and what the
# report says about the gap, is in `criteria.json`.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test. Delete every copy so the baseline cannot read the
# specification it is meant to be missing. The plugin variant supplies
# `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

if [ ! -d .git ]; then
  git init -q
  git config user.email "eval@example.invalid"
  git config user.name "Tessl Eval"
fi

# Harness symlinks and the planted review report stay out of the diff.
mkdir -p .git/info
printf '.claude/\n.agents/\nREVIEW-TESTS.md\n' >> .git/info/exclude

# Fold any install-time drift into history before branching.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/cire-guest-note-cap

mkdir -p cire/api/src/lib .changeset
cat > cire/api/src/lib/guest-note.ts <<'SRC'
/** Longest dietary note a guest may send, in characters. */
export const GUEST_NOTE_MAX = 500;

/** Trim a guest's note and cut it to the cap. */
export function capGuestNote(input: string): string {
  const trimmed = input.trim();
  return trimmed.length > GUEST_NOTE_MAX ? trimmed.slice(0, GUEST_NOTE_MAX) : trimmed;
}
SRC

cat > .changeset/cire-guest-note-cap.md <<'CS'
---
"@cire/api": patch
---

Cap the dietary note a guest can send at 500 characters.
CS

git add -A
git commit -qm "feat(cire-api): cap the guest dietary note at 500 characters"

cat > REVIEW-TESTS.md <<'REPORT'
# Test review — feat/cire-guest-note-cap

## Build

Not run: no package tooling in this checkout.

## Tests

Not run: no package tooling in this checkout.

## Coverage gaps

### T-M1 — `cire/api/src/lib/guest-note.ts` has no test file

- **Issue:** the module is changed on this branch and no test file reaches it.
- **Why:** `capGuestNote` is the only guard on the length of a guest's free-text dietary note. A regression in it lets an arbitrarily long note reach the organiser's sheet.
- **Solution:** add `cire/api/tests/lib/guest-note.test.ts`, in the `bun:test` style of its siblings in `cire/api/tests/lib/`, asserting: a note under the cap comes back trimmed; a note of 501 characters comes back as exactly 500 characters; a whitespace-only note comes back as the empty string.
- **Rationale:** a coverage gap found on the branch is written on the branch before the pull request. Not filed.

## Files audited

- `cire/api/src/lib/guest-note.ts` — T-M1, no test file. The only changed source file.

## Not run

Build, tests, and mutation run: no toolchain.
REPORT

echo "fixture ready"
