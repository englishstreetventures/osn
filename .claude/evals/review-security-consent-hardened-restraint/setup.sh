#!/usr/bin/env bash
# Make the consent framework a reviewable branch diff, one fix later than
# `review-security-consent-cookie-rediscovery` pins it.
#
# The fixture tree already contains the module, so `git diff main...HEAD` would
# be empty. Construct a base where it is absent and a branch that adds it back,
# which makes the module itself the branch's diff.
#
# This scenario scores restraint, so the strip below matters: see the comment
# on it. The ground truth is in `graders/` and is not repeated here.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git ebbef4c45e5eebaac499804755b8f3c802bac79b
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

# Commit the removal on the base, so no branch cut below shows it in its diff.
git add -A
git diff --cached --quiet || git commit -qm "fixture: install state"

CONSENT_PATHS=(
  cire/invites/src/lib/consent
  cire/invites/src/components/consent
)

git checkout -q -B main
git rm -rq "${CONSENT_PATHS[@]}"
git commit -qm "base: cire consent framework not yet added"

# The skill's first step fetches the base branch. Without a remote that fails
# every run, costing turns. Point origin at this repository so it succeeds.
git remote remove origin 2>/dev/null || true
git remote add origin "$PWD"

git checkout -q -b feat/cire-consent-framework
git revert --no-edit --no-commit HEAD

# The module's comments and three `describe` titles cite the tracker issues
# filed against an earlier version of this code. A reference of that form
# states in prose what the scenario asks the reviewer to work out from the
# code, so it is removed. Only the references go: a comment line naming one is
# dropped whole, a reference inside a string literal loses just the
# parenthetical, the reasoning around them stays, and no code changes.
python3 - <<'PYEOF'
import pathlib, re

ROOTS = ("cire/invites/src/lib/consent", "cire/invites/src/components/consent")
COMMENT = re.compile(r"\s*(\*|//)")
PARENTHETICAL = re.compile(r"\s*\(osn-tracker#\d+[^)]*\)")

for root in ROOTS:
    for path in pathlib.Path(root).rglob("*.ts*"):
        original = path.read_text()
        kept = [
            line
            for line in original.splitlines(keepends=True)
            if "osn-tracker#" not in line or not COMMENT.match(line)
        ]
        text = PARENTHETICAL.sub("", "".join(kept))
        if text != original:
            path.write_text(text)
            print(f"stripped tracker references from {path}")
PYEOF

if grep -rq 'osn-tracker#' cire/invites/src/lib/consent cire/invites/src/components/consent; then
  echo "setup: tracker references survived the strip" >&2
  exit 1
fi

git add -A
git commit -qm "feat(cire): site-wide cookie and third-party consent framework"

git config branch.feat/cire-consent-framework.gh-merge-base main
