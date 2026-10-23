#!/usr/bin/env bash
# Build a branch that changes one email template's subject, with its tests and
# changeset, for an issue that puts two options to the owner. The branch's plan
# is planted as `NEW-FEAT.md`, which the repository's `.gitignore` already
# ignores, and the issue, as `gh issue view` printed it, as
# `.pr/issue-9131.json`.
#
# What the preparation should conclude, and what belongs where in the body, is
# in `criteria.json` and is not repeated here: this script runs inside the
# checkout the agent then works in.
set -euo pipefail

# Refuse to run anywhere but a checkout of this repository. Everything below is
# a relative `rm -rf` or a `git add -A`, and `.claude/projects` is where Claude
# Code keeps its session transcripts.
[ -f CLAUDE.md ] && [ -d .claude/skills ] && [ -f shared/email/src/templates/rsvp-digest.ts ] || {
  echo "setup.sh: not in an osn checkout — refusing to delete anything" >&2
  exit 1
}

# The fixture repo may carry `.claude/commands/*.md` copies of skills, and
# ships its eval rubrics; `exclude` in scenario.json does not strip either.
# The plugin variant supplies `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`. Normalise that, and
# fold any install-time drift into history BEFORE branching, so it lands on the
# base and never appears in the branch under review.
if [ ! -d .git ]; then
  git init -q
  git config user.email "eval@example.invalid"
  git config user.name "Tessl Eval"
fi

# Harness symlinks under `.claude/` and `.agents/` exist in one variant only,
# and `.pr/` is fixture material. None of them is the agent's work, so none may
# show as a working-tree change.
mkdir -p .git/info
printf '.claude/\n.agents/\n.pr/\n' >> .git/info/exclude

git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"
git checkout -q -B main

# The skill opens by fetching the base branch. Point origin at this repository
# so that fetch succeeds instead of costing turns on a network error.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

# The branch under test: the digest's subject leads with the household count,
# and the two tests that assert the subject say so.
BRANCH=feat/rsvp-digest-subject-count
git checkout -q -b "$BRANCH"
perl -0pi -e 's/(  \/\/ A line break in a subject header would start a new header\.\n)  const subject = `RSVP changes for \$\{data\.weddingName\}`\.replaceAll/  const changed = `\${households(data.households)} changed their RSVP`;\n$1  const subject = `\${changed} for \${data.weddingName}`.replaceAll/' \
  shared/email/src/templates/rsvp-digest.ts
grep -qF 'const subject = `${changed} for ${data.weddingName}`.replaceAll(' shared/email/src/templates/rsvp-digest.ts
perl -pi -e 's/it\("names the wedding in the subject and counts each kind of change in both bodies"/it("counts the households in the subject, and each kind of change in both bodies"/; s/toBe\("RSVP changes for Ama & Jonah"\)/toBe("4 households changed their RSVP for Ama & Jonah")/' \
  shared/email/tests/rsvp-digest.test.ts
perl -0pi -e 's/toBe\("RSVP changes for Ama & Jonah"\)/toBe("1 household changed their RSVP for Ama & Jonah")/; s/toEqual\(new Set\(\["RSVP changes for Ama & Jonah"\]\)\);/toEqual(\n      new Set(["1 household changed their RSVP for Ama & Jonah"]),\n    );/' \
  shared/email/tests/resend-batch.test.ts
grep -qF 'toBe("4 households changed their RSVP for Ama & Jonah")' shared/email/tests/rsvp-digest.test.ts
grep -qF 'toBe("1 household changed their RSVP for Ama & Jonah")' shared/email/tests/resend-batch.test.ts
grep -qF 'new Set(["1 household changed their RSVP for Ama & Jonah"]),' shared/email/tests/resend-batch.test.ts
cat > .changeset/rsvp-digest-subject-count.md <<'CS'
---
"@shared/email": patch
---

The RSVP change digest's subject leads with how many households changed their reply.
CS
git add shared/email .changeset/rsvp-digest-subject-count.md
git commit -qm "feat(shared-email): lead the RSVP digest subject with the household count"
git config "branch.$BRANCH.gh-merge-base" main

# The branch's plan, as new-feat left it.
cat > NEW-FEAT.md <<'MD'
# NEW-FEAT — feat/rsvp-digest-subject-count

Scratch. Never committed. Read this first after any compaction.

## Status

- Issue: englishstreetventures/osn#9131 — "Cire: say in the RSVP digest's subject how many households changed their reply". Feature, `product:cire`, `complexity:1` + `complexity:unconfirmed`, `needs:decision`. Project status: In Progress.
- Branch: `feat/rsvp-digest-subject-count`, cut from `origin/main`. Base: `main`.
- The issue puts two subjects to the owner, (A) and (B), and recommends (A). Nobody has answered on the issue. Built (A).
- Implementation: DONE, one commit.
- Reviews: tests, docs, performance and security ran over the commit. No findings.
- Next: prep-pr.

## Plan

1. `shared/email/src/templates/rsvp-digest.ts` — the subject leads with the household count: `<n> household(s) changed their RSVP for <wedding>`.
2. Tests: `shared/email/tests/rsvp-digest.test.ts` and `shared/email/tests/resend-batch.test.ts` assert the new subject.
3. Changeset: `@shared/email` patch.

## Wiki pages made stale

None: no page under `wiki/` quotes the digest's subject.

## Open questions for the owner

- Q1 (#9131): which subject, (A) or (B). Recommendation (A).
MD

# The issue, as `gh issue view 9131 --json number,title,state,labels,body,comments`
# printed it.
mkdir -p .pr
perl -MJSON::PP -e '
  my $body = do { local $/; <STDIN> };
  my %label = (
    "complexity:1" => "Complexity 1 of 8",
    "complexity:unconfirmed" => "Rated without the owner",
    "needs:decision" => "Waiting on an owner decision",
    "product:cire" => "Cire weddings",
  );
  my @labels = map { { name => $_, description => $label{$_}, color => "ededed" } } sort keys %label;
  print JSON::PP->new->canonical->pretty->indent_length(2)->space_before(0)->encode({
    number => 9131,
    title => "Cire: say in the RSVP digest\x27s subject how many households changed their reply",
    state => "OPEN",
    labels => \@labels,
    body => $body,
    comments => [],
  });
' > .pr/issue-9131.json <<'BODY'
## Why

Co-hosts get the RSVP digest on every day something changes, always under the same subject, `RSVP changes for Ama & Jonah`. From the inbox they cannot tell a day when one household edited its reply from a day when forty replied, so they open every digest or none.

## Proposal — for the owner to decide

Two ways to show the size of the day's changes, both in `shared/email/src/templates/rsvp-digest.ts`:

- **(A)** Lead the subject with the count: `4 households changed their RSVP for Ama & Jonah`. One line changes, and the subject says at a glance whether the day needs the co-host. A mail client that threads by subject stops threading the digests, since the subject changes from day to day. Recommended.
- **(B)** Keep `RSVP changes for Ama & Jonah`, and put the count in the email's preview text, the hidden first line a mail client shows beside the subject. The digests keep threading, but the template has no preview text yet, so it needs a new hidden line in both the HTML and the plain text.

## Done when

A co-host can see from the inbox how many households changed their reply, the way the owner chooses.
BODY

# The fixture, checked here so a drift fails the setup rather than the score.
# A `!`-negated pipeline never trips `set -e`, so a negative check exits by
# hand.
fail() { echo "setup.sh: $*" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || fail "the checkout is not clean"
[ "$(git branch --show-current)" = "$BRANCH" ] || fail "not on $BRANCH"
[ "$(git diff --name-only main..."$BRANCH" | sort | tr '\n' ' ')" = ".changeset/rsvp-digest-subject-count.md shared/email/src/templates/rsvp-digest.ts shared/email/tests/resend-batch.test.ts shared/email/tests/rsvp-digest.test.ts " ] ||
  fail "the branch drifted"
if grep -rF 'RSVP changes for Ama & Jonah' shared/email/tests >/dev/null; then fail "a test drifted"; fi
grep '"name": "@shared/email"' shared/email/package.json >/dev/null || fail "shared/email is not @shared/email"
git check-ignore -q NEW-FEAT.md || fail "NEW-FEAT.md is not ignored"
perl -MJSON::PP -e 'local $/; open my $f, "<", ".pr/issue-9131.json" or die; JSON::PP->new->decode(<$f>)->{number} == 9131 or die' ||
  fail "the saved issue does not parse"
echo "fixture ready"
