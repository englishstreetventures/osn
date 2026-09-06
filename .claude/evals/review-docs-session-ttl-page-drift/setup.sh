#!/usr/bin/env bash
# Make a guest-session TTL change, with the wiki page that describes the
# cookie edited alongside it, a reviewable branch diff.
#
# The branch changes the constant in the two routes that mint the cookie,
# updates two of the page's mentions of the old value, and renames one of the
# page's headings. What the page still says, what links into that heading,
# and which other pages carry the old value are in `criteria.json` and are
# deliberately not repeated here: this script runs inside the checkout the
# agent then reviews.
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

# One base-side edit, folded into the install-state commit: the compliance
# register's guest-credential row links to the section of the auth page that
# defines the claim code, by heading, rather than to the page as a whole.
perl -pi -e 's/^(\| Cire guest \|.*) \[\[cire-auth\]\] \|$/$1 [[cire-auth#Claim-code format (C1)]] |/' \
  wiki/compliance/access-control.md
grep -q 'cire-auth#Claim-code format (C1)' wiki/compliance/access-control.md

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
