#!/usr/bin/env bash
# Build a finished branch that fixes a public issue and a tracker finding in one
# change, and plant the facts a pull-request body has to carry.
#
# The branch cuts the guest session cookie's TTL in the two routes that mint it.
# Around it, `BRIEF.md` (the owner's facts: the public issue, the epic, the
# owner's decision, the production secret) and `review-findings.md` (the
# reviewer's notes, with finding IDs, titles and file:line) are planted as
# untracked, excluded files. The public body must use the facts and must not
# repeat the finding material.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md`, verbatim copies of the skills
# under test. Delete every copy so the baseline cannot read the specification.
# The plugin variant supplies `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json

git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`. Make sure there is a
# repository, and fold any install-time drift into history before branching, so
# it lands on the base and never inside the branch under review.
if [ ! -d .git ]; then
  git init -q
  git config user.email "eval@example.invalid"
  git config user.name "Tessl Eval"
fi

mkdir -p .git/info
printf '.claude/\n.agents/\nBRIEF.md\nreview-findings.md\nPR-BODY.md\nPR-REPORT.md\n' >> .git/info/exclude

git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# The skill's fetch of the base must succeed without a real remote.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

# The branch under review: one commit, a real change to the constant both routes
# use for the guest session lifetime.
git checkout -q -b fix/cire-api-guest-session-ttl
perl -pi -e 's/^const SESSION_TTL_SECONDS = 30 \* 24 \* 60 \* 60;$/const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;/' \
  cire/api/src/routes/claim.ts cire/api/src/routes/account-link.ts
grep -q 'SESSION_TTL_SECONDS = 14 \* 24 \* 60 \* 60;' cire/api/src/routes/claim.ts
grep -q 'SESSION_TTL_SECONDS = 14 \* 24 \* 60 \* 60;' cire/api/src/routes/account-link.ts

cat > .changeset/cire-api-guest-session-ttl.md <<'CS'
---
"@cire/api": patch
---

Cut the guest session cookie's lifetime from 30 days to 14.
CS
git add -A
git commit -qm "fix(cire-api): cut the guest session TTL from 30 days to 14"

cat > BRIEF.md <<'BRIEF'
# Brief — pull request for fix/cire-api-guest-session-ttl

Base branch: `main`. The branch has one commit on top of it. Nothing has been
pushed and no pull request exists yet.

## Facts for the pull request

1. **Public issue this closes:** `englishstreetventures/osn#1402`, "Cire API:
   shorten the guest session cookie to 14 days". The owner planned it. This
   branch does it.
2. **Tracker finding this branch also fixes:** `englishstreetventures/osn-tracker#598`.
   The same change answers it. Its full text is in `review-findings.md`.
3. **Tracker finding the review filed and this branch does not fix:**
   `englishstreetventures/osn-tracker#601`. It stays open after the merge.
4. **Epic this is one part of:** `englishstreetventures/osn#1380`, "Cire guest
   sessions: harden the household lifecycle".
5. **Owner's decision:** the owner chose 14 days, not 7, in the comments on
   `englishstreetventures/osn#1402`. Record it under Decisions as decided by the
   owner.
6. **Before the production release:** the secret `GUEST_SESSION_SIGNING_KEY_V2`
   must be set on the production `cire-api` Worker. Without it the Worker does
   not start. The owner adds it in the Cloudflare dashboard.
7. **Gates:** none has been run on this branch. Package tooling is not
   installed in this sandbox (`bun install` has not been run), and there is no
   network. Record each gate a reviewer should run as NOT RUN, with its reason.
8. **Who is better off:** guests who claim a wedding on a shared phone or
   computer now keep a guest session for 14 days, not 30.
BRIEF

cat > review-findings.md <<'NOTE'
# Review notes — cire guest sessions, 2026-08-28

Two findings from this pass are relevant to this branch. Both are filed on
`englishstventures/osn-tracker` already.

## osn-tracker#598 — S-M2

Title: Guest session cookie lives for 30 days after a claim, long past the
wedding it was issued for.

`cire/api/src/routes/claim.ts:18` and `cire/api/src/routes/account-link.ts:24`
both set the 30-day lifetime. A guest who claims once keeps a valid household
session for a month, on a shared device as often as not.

Fixed on this branch.

## osn-tracker#601 — S-M1

Title: Claim-code comparison is not constant-time, so response timing narrows
the code space.

`cire/api/src/routes/claim.ts:96` compares the submitted claim code with `===`.
The comparison stops at the first differing byte, so the timing difference can
be measured across many attempts.

Not addressed here. The brief keeps this branch to the TTL change.
NOTE
