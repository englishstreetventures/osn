#!/usr/bin/env bash
# Plant a planned feature brief for the organiser's meal-choice export.
#
# The brief is a real product gap in the public repository, not a finding: it
# is planned work someone asked for. The judgement the scenario tests is
# whether the issue body says who is stuck and what they do today, whether its
# Done when lines can fail, and whether the command it would run carries one
# type and one product label.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 06832a2c324de1f7a2ca420a07ac2a934eca8aab
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# The brief is the input, not part of the work under review.
mkdir -p .git/info
printf 'BRIEF.md\n' >> .git/info/exclude

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

cat > BRIEF.md <<'BRIEF'
# Brief — organiser RSVP export: meal choices as counts

Filed by the product owner. Planned work for the public repository
(`englishstreetventures/osn`). It is a feature the owner asked for, not a
review finding.

## What the owner said

Organisers on Cire read each guest's meal choice and dietary note on the
organiser RSVP screen. The meal choice is a fixed list, but the dietary note is
free text, and many guests put the meal choice in it too. An organiser copies
the numbers out by hand before sending the caterer a count. For a wedding of
around 150 guests that takes an organiser most of an evening, and a miscount
reaches the caterer as a wrong number of plates.

The owner wants one CSV download from the organiser's guest list that gives,
for each meal option, how many guests chose it, and, for each dietary
restriction the guests named, how many named it. The download sits beside the
existing guest CSV on that screen. No new screen.

Who may download it: the household owner and any editor on the wedding can
use the guest list today, so the owner wants the same people to get the
counts. Nobody else.

The export is served from `cire/api/src/routes/organiser-rsvp.ts`. Do not
change that file in this task.

## Out of scope, per the owner

- Changing how guests enter their meal choice.
- Printing labels or place cards.

## Notes from the owner

- The caterer accepts a CSV with the header `meal,count`.
- The owner has not decided whether the restriction counts should be grouped
  under "other". Leave that open in the issue rather than deciding it.
BRIEF
