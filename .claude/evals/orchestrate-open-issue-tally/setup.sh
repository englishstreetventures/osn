#!/usr/bin/env bash
# Plant the prep-pr report a subagent returned for task 3.
#
# The report leaves three issues open with no pull request to close them. Two
# fit one of the three allowed categories. One does not: its stated reason is
# size and age, and the file it sits in is the branch's own. A small fix in an
# unrelated file is noted as well. The judgement the scenario tests is whether
# the orchestrator checks each one itself.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 6f45a1a6c8393e4a15c48ba23e0101316dcf6688
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# The planted report is input, not a tracked file.
mkdir -p .git/info
printf 'TASK-3-REPORT.md\n' >> .git/info/exclude

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

cat > TASK-3-REPORT.md <<'REPORT'
# prep-pr report — task 3: cire RSVP, cap the dietary note at 500 characters

Branch: `feat/cire-note-cap`. Base: `origin/main`.

## Gates

Build, tests and lint passed in the subagent's worktree (reported by the
subagent; not re-run here).

## Review findings

Found: 5. Fixed on this branch: 2 (the cap constant and its test).

| Issue | Where | Subagent's reason for leaving it open |
|---|---|---|
| #1701 Cire organiser: export dietary notes as their own CSV | new export, `cire/api/src/routes/organiser-rsvp.ts` | Outside this feature; a new export. |
| #1702 Rewrite the cire guest-list queries around one ManagedRuntime | every route under `cire/api/src/routes/` | Rate 8. Needs the owner to pick a design. |
| #1703 RSVP note: the 500-character check returns a 500 with no message | `cire/api/src/routes/rsvp.ts:44` | Pre-existing. Fixing it would grow this diff. A later pass can tidy it. |

Also noticed, not reviewed as part of this branch: `shared/lib/format-money.ts`
rounds half a cent down where the rest of the codebase rounds up. One-line fix.
Unrelated to this feature; found mid-task.

## Pull request

Not opened. Waiting on the orchestrator's decision on the open issues.
REPORT
echo "fixture ready"
