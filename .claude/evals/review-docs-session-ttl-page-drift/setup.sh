#!/usr/bin/env bash
# Make a guest-session TTL change, with the wiki page that describes the
# cookie edited alongside it, a reviewable branch diff.
#
# The branch changes the constant in the two routes that mint the cookie,
# updates two of the page's mentions of the old value, and renames one of the
# page's headings. What the page still says, what links into that heading, and
# which other pages carry the old value are in `graders/` and are deliberately
# not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 375add03752b60ee939a9189b4f1910479f7ea14
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# One base-side edit, folded into the install-state commit: the compliance
# register's guest-credential row links to the section of the auth page that
# defines the claim code, by heading, rather than to the page as a whole.
perl -pi -e 's/^(\| Cire guest \|.*) \[\[cire-auth\]\] \|$/$1 [[cire-auth#Claim-code format (C1)]] |/' \
  wiki/compliance/access-control.md
grep -q 'cire-auth#Claim-code format (C1)' wiki/compliance/access-control.md

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

git checkout -q -B main

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

# The branch under test. A real change to the constant its commit message and
# changeset both describe, in both routes that mint the guest session cookie.
git checkout -q -b fix/cire-api-guest-session-ttl
perl -pi -e 's/^const SESSION_TTL_SECONDS = 30 \* 24 \* 60 \* 60;$/const SESSION_TTL_SECONDS = 14 * 24 * 60 * 60;/' \
  cire/api/src/routes/claim.ts cire/api/src/routes/account-link.ts
grep -q 'SESSION_TTL_SECONDS = 14 \* 24 \* 60 \* 60;' cire/api/src/routes/claim.ts
grep -q 'SESSION_TTL_SECONDS = 14 \* 24 \* 60 \* 60;' cire/api/src/routes/account-link.ts

# The wiki edit that travels with it: two of the page's mentions of the old
# lifetime, and a heading that loses its parenthetical tag.
perl -pi -e '
  s/30-day TTL, host-scoped/14-day TTL, host-scoped/;
  s/so a 30-day credential that auto-exercises/so a 14-day credential that auto-exercises/;
  s/^### Claim-code format \(C1\)$/### Claim-code format/;
' wiki/systems/cire-auth.md
grep -q '14-day TTL, host-scoped' wiki/systems/cire-auth.md
grep -q 'a 14-day credential' wiki/systems/cire-auth.md
grep -q '^### Claim-code format$' wiki/systems/cire-auth.md

# `@cire/*` is version-less, so this changeset is correct as it stands; it
# exists so the branch looks like every other branch in this repository.
cat > .changeset/cire-api-guest-session-ttl.md <<'CS'
---
"@cire/api": patch
---

Halve the guest session cookie's lifetime, from 30 days to 14.
CS
git add -A
git commit -qm "fix(cire-api): cut the guest session TTL from 30 days to 14, and refresh the auth page"

git config branch.fix/cire-api-guest-session-ttl.gh-merge-base main
