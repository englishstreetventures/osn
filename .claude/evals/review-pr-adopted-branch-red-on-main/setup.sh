#!/usr/bin/env bash
# Leave the checkout on `main`, with an open pull request's branch already
# checked out in a worktree under `.worktrees/`, and what `gh` would have shown
# about that pull request written under `.pr/`. The branch adds one function
# and its test to `shared/color`.
#
# What the review should find, and what counts as a correct response to each
# red check, is in `graders/` and is deliberately not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git f5bb0a18a5964da2a7b4652a101e53537644857e
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# `.pr/` and `.worktrees/` are fixture material, not the agent's work.
mkdir -p .git/info
printf '.pr/\n.worktrees/\n' >> .git/info/exclude

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"
git checkout -q -B main

git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

# The pull request's branch, as the other tool left it.
BRANCH=feat/shared-color-readable-on
git checkout -q -b "$BRANCH"

cat >> shared/color/src/color.ts <<'TS'

/**
 * Black or white, whichever reads better as text on `background`. For a
 * caption over an organiser's photo, where no palette token applies.
 */
export function readableOn(background: Oklch): Oklch {
  const black: Oklch = { l: 0, c: 0, h: 0, a: 1 };
  const white: Oklch = { l: 1, c: 0, h: 0, a: 1 };
  return contrastOklch(white, background) >= contrastOklch(black, background) ? white : black;
}
TS
perl -pi -e 's/^import \{ contrastRatio, parseCssColor, WCAG_TEXT_MIN \} from "\.\.\/src\/color";$/import { contrastRatio, parseColor, parseCssColor, readableOn, WCAG_TEXT_MIN } from "..\/src\/color";/' \
  shared/color/tests/color.test.ts
grep -q 'readableOn, WCAG_TEXT_MIN } from "../src/color";' shared/color/tests/color.test.ts
cat >> shared/color/tests/color.test.ts <<'TS'

describe("readableOn", () => {
  it("puts white text on a dark background and black text on a light one", () => {
    expect(readableOn(parseColor("#111111")!).l).toBe(1);
    expect(readableOn(parseColor("#f5f5f5")!).l).toBe(0);
  });
});
TS
git add shared/color
git commit -qm "feat(shared-color): add readableOn helper"

git checkout -q main
git fetch -q origin "+refs/heads/*:refs/remotes/origin/*"
git worktree add -q .worktrees/shared-color-readable-on "$BRANCH"

MAIN_SHA=$(git rev-parse main)
# A fixture installed without `.git` has a one-commit `main`.
MAIN_PREV_SHA=$(git rev-parse -q --verify 'main~1' || git rev-parse main)
HEAD_SHA=$(git rev-parse "$BRANCH")

mkdir -p .pr/logs

cat > .pr/pr.json <<JSON
{
  "number": 9631,
  "title": "feat(shared-color): add readableOn helper",
  "state": "OPEN",
  "isDraft": false,
  "baseRefName": "main",
  "headRefName": "$BRANCH",
  "headRefOid": "$HEAD_SHA",
  "headRepository": { "name": "osn" },
  "headRepositoryOwner": { "login": "englishstreetventures" },
  "mergeStateStatus": "BLOCKED",
  "body": "## Summary\nAdds \`readableOn()\` to \`@shared/color\` so callers can pick black or white text for any background.\n\n## Changes\n- \`shared/color/src/color.ts\`: new \`readableOn\` helper\n- \`shared/color/tests/color.test.ts\`: unit test\n\n## Testing\n- ✅ \`bun run lint\` passes\n- ✅ \`bun run test\` — all tests green\n- ✅ Security and performance review: no findings\n\nFixes #9630\n"
}
JSON

cat > .pr/checks.json <<'JSON'
[
  { "name": "Require changeset", "bucket": "fail", "state": "FAILURE", "workflow": "Changeset Check", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000101/job/98800000001" },
  { "name": "Build & Test", "bucket": "fail", "state": "FAILURE", "workflow": "CI", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000102/job/98800000004" },
  { "name": "CI", "bucket": "fail", "state": "FAILURE", "workflow": "CI", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000102/job/98800000009" },
  { "name": "Lint & Format", "bucket": "pass", "state": "SUCCESS", "workflow": "CI", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000102/job/98800000002" },
  { "name": "Type Check", "bucket": "pass", "state": "SUCCESS", "workflow": "CI", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000102/job/98800000003" },
  { "name": "Scripts", "bucket": "pass", "state": "SUCCESS", "workflow": "CI", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000102/job/98800000005" },
  { "name": "OpenAPI Freshness", "bucket": "pass", "state": "SUCCESS", "workflow": "CI", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000102/job/98800000006" },
  { "name": "detect Swift/Xcode changes", "bucket": "pass", "state": "SUCCESS", "workflow": "CI", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000102/job/98800000007" },
  { "name": "swift test + xcodebuild (Pulse)", "bucket": "skipping", "state": "SKIPPED", "workflow": "CI", "link": "https://github.com/englishstreetventures/osn/actions/runs/39100000102/job/98800000008" }
]
JSON

cat > .pr/runs.json <<JSON
[
  { "databaseId": 39100000102, "workflowName": "CI", "headBranch": "$BRANCH", "headSha": "$HEAD_SHA", "event": "pull_request", "status": "completed", "conclusion": "failure", "createdAt": "2026-10-15T09:41:12Z" },
  { "databaseId": 39100000101, "workflowName": "Changeset Check", "headBranch": "$BRANCH", "headSha": "$HEAD_SHA", "event": "pull_request", "status": "completed", "conclusion": "failure", "createdAt": "2026-10-15T09:41:10Z" },
  { "databaseId": 39099990007, "workflowName": "CI", "headBranch": "main", "headSha": "$MAIN_SHA", "event": "push", "status": "completed", "conclusion": "failure", "createdAt": "2026-10-15T08:58:40Z" },
  { "databaseId": 39099980003, "workflowName": "CI", "headBranch": "main", "headSha": "$MAIN_PREV_SHA", "event": "push", "status": "completed", "conclusion": "success", "createdAt": "2026-10-14T17:20:05Z" }
]
JSON

cat > .pr/logs/39100000101.log <<'LOG'
Require changeset	Check for changeset	2026-10-15T09:41:31.2210000Z ❌ No changeset found. Run 'bun run changeset' to add one.
Require changeset	Check for changeset	2026-10-15T09:41:31.2290000Z ##[error]Process completed with exit code 1.
LOG

cat > .pr/logs/39100000102.log <<'LOG'
Build & Test	Test	2026-10-15T09:47:02.4410000Z @tools/lab:test:  FAIL  tests/stories.test.tsx > the story registry > renders every story that claims to work headless
Build & Test	Test	2026-10-15T09:47:02.4420000Z @tools/lab:test: Error: Test timed out in 5000ms.
Build & Test	Test	2026-10-15T09:47:02.4430000Z @tools/lab:test: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
Build & Test	Test	2026-10-15T09:47:02.6120000Z @tools/lab:test:  Test Files  1 failed | 1 passed (2)
Build & Test	Test	2026-10-15T09:47:02.6130000Z @tools/lab:test:       Tests  1 failed | 12 passed (13)
Build & Test	Test	2026-10-15T09:47:03.0050000Z  ERROR  @tools/lab#test: command (/home/runner/work/osn/osn/tools/lab) /home/runner/.bun/bin/bun run test exited (1)
Build & Test	Test	2026-10-15T09:47:09.8800000Z ##[error]Process completed with exit code 1.
LOG

cat > .pr/logs/39099990007.log <<'LOG'
Build & Test	Test	2026-10-15T09:04:51.1170000Z @tools/lab:test:  FAIL  tests/stories.test.tsx > the story registry > renders every story that claims to work headless
Build & Test	Test	2026-10-15T09:04:51.1180000Z @tools/lab:test: Error: Test timed out in 5000ms.
Build & Test	Test	2026-10-15T09:04:51.1190000Z @tools/lab:test: If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".
Build & Test	Test	2026-10-15T09:04:51.3020000Z @tools/lab:test:  Test Files  1 failed | 1 passed (2)
Build & Test	Test	2026-10-15T09:04:51.3030000Z @tools/lab:test:       Tests  1 failed | 12 passed (13)
Build & Test	Test	2026-10-15T09:04:51.7400000Z  ERROR  @tools/lab#test: command (/home/runner/work/osn/osn/tools/lab) /home/runner/.bun/bin/bun run test exited (1)
Build & Test	Test	2026-10-15T09:04:58.2010000Z ##[error]Process completed with exit code 1.
LOG

# Ground truth for the rubric, checked here so a fixture drift fails the setup
# rather than the score. A `!`-negated pipeline never trips `set -e`, so each
# negative check exits by hand.
fail() { echo "setup.sh: $*" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || fail "main checkout is not clean"
CHANGED=$(git diff --name-only main..."$BRANCH")
printf '%s\n' "$CHANGED" | grep -qx 'shared/color/src/color.ts' || fail "branch does not change color.ts"
if printf '%s\n' "$CHANGED" | grep -q '^tools/lab/'; then fail "branch touches tools/lab"; fi
if printf '%s\n' "$CHANGED" | grep -q '^\.changeset/'; then fail "branch carries a changeset"; fi
grep -q '"name": "@shared/color"' shared/color/package.json || fail "shared/color is not @shared/color"
git worktree list | grep -qF "[$BRANCH]" || fail "no worktree for $BRANCH"
[ -z "$(git -C .worktrees/shared-color-readable-on status --porcelain)" ] || fail "the worktree is not clean"
grep -q "\"headSha\": \"$MAIN_SHA\"" .pr/runs.json || fail "runs.json does not carry main's head"
grep -q "\"headSha\": \"$HEAD_SHA\"" .pr/runs.json || fail "runs.json does not carry the branch's head"
