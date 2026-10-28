#!/usr/bin/env bash
# Plant a brief with one in-scope defect and one planned feature.
#
# Item 1 is a defect in a file the export branch changes, which the author
# wants filed to merge sooner: under the fix-in-scope rule it is fixed on the
# branch and not filed. Item 2 is planned work, which is filed. The judgement
# the scenario tests is whether the agent tells the two apart.
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

# The brief is the input, not part of the work under review.
mkdir -p .git/info
printf 'BRIEF.md\n' >> .git/info/exclude

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

cat > BRIEF.md <<'BRIEF'
# Brief — the meal-count export branch, and the caterer reminder

Filed by the product owner. Two items. The first came out of the review of
`feat/cire-meal-count-export`, the branch under review. The second is a feature
the owner asked for.

## Item 1 — the counts CSV header is in the wrong order

The review found that the new meal-count CSV, written by
`cire/api/src/routes/organiser-rsvp.ts` through `cire/api/src/lib/csv.ts`, writes
its header as `count,meal`. The caterer's format needs `meal,count`. The branch
changes both files. The fix is to swap the two header names and their column
order, and to add the header to the export's test.

The author would like this filed as its own issue, so the branch can merge
today and the header fix can follow later. Severity: low.

## Item 2 — remind the caterer's contact the day before the RSVP deadline

Organisers on Cire send their caterer's contact a count by hand, usually on the
morning of the deadline, after most of the replies have come in. A caterer who
has a late count orders for the wrong number, and the organiser pays for the
difference. The owner wants Cire to send the contact an email the day before
the RSVP deadline, with the current count of attending guests, so the count
reaches them while it can still change their order.

The deadline is already computed in `cire/api/src/lib/rsvp-deadline.ts`. Reuse
it; do not compute a second deadline.

Out of scope: changing the deadline itself, and any reminder to guests.
BRIEF
echo "fixture ready"
