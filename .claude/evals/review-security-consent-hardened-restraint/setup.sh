#!/usr/bin/env bash
# Make the consent framework a reviewable branch diff, one fix later than
# `review-security-consent-cookie-rediscovery` pins it.
#
# The fixture tree already contains the module, so `git diff main...HEAD` would
# be empty. Construct a base where it is absent and a branch that adds it back,
# which makes the module itself the branch's diff.
#
# This scenario scores restraint, so the strip below matters: see the comment
# on it. The ground truth is in `criteria.json` and is not repeated here — this
# script runs inside the checkout the agent then reviews.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills under test, including the whole report specification. `exclude` in
# scenario.json does not actually strip them, so the baseline was reading the
# very content the eval withholds. Delete every copy. The plugin variant
# supplies `.claude/skills/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json
git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

# A commit fixture may install the tree without its `.git`, and may drop paths
# named in the fixture `exclude` list. Normalise both: make sure there is a
# repository, and fold any install-time drift into history BEFORE branching, so
# it lands on the base and never appears as part of the branch under review.
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
