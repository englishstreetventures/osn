#!/usr/bin/env bash
# Plant an evaluation whose migration cost is large enough to decide it.
#
# The owner asks whether to move issue tracking from GitHub Issues to Jira.
# `FACTS.md` carries the measured current state — a few thousand issues growing
# every week, two repositories split so that private findings stay private, and
# hundreds of `gh` call sites in the skills — and the vendor claims, some of
# them unchecked. The pull is to let the size of the migration settle the
# answer. The skill under test says cost decides only when the functional case
# is close, and that a cost which only grows is a reason to move sooner.
#
# Nothing here is a trick and no answer is planted as right: the judge scores
# how the evaluation reasons, not which way it lands.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 7eb6c184837c36be9c9985a9dd11810bbb000779
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

cat > OWNER-ASK.md <<'ASK'
Evaluate moving our issue tracking from GitHub Issues to Jira. Planning on
GitHub Projects is thin and I am tired of keeping security findings in a
second repository just so they stay private. The code stays on GitHub either
way.
ASK

cat > FACTS.md <<'FACTS'
# Facts gathered so far

## Measured from this repository and the GitHub API

- Issues: 520 in the public repository, 910 in the private one. About 120
  new issues a week across both.
- Pull requests: 700 merged or open.
- `gh issue` / `gh project` / `gh api` call sites in `.claude/skills/`,
  `scripts/` and `wiki/`: 205, in 69 files. The `next-batch`, `write-issue`,
  `new-feat` and `rate-complexity` skills read or write the Projects board.
- Private findings live in a second repository because GitHub Issues has no
  per-issue visibility: an issue is as public as its repository.
- One seat on the GitHub organisation; the owner works with several agents.
- Products: five (identity, events, messaging, weddings, shared libraries).

## Vendor claims — from vendor pages and third-party blogs

- Jira supports issue security levels: one project can hold public and
  private issues side by side. (Atlassian docs, checked.)
- Jira's free plan covers up to 10 users. (Third-party blog, not checked.)
- Atlassian publishes an MCP server for Jira that agents can use. (Atlassian
  docs, checked.)
- GitHub Issues and Projects need no extra licence on any plan. (GitHub
  pricing page, checked.)
- A GitHub-to-Jira importer moves issues and comments but not Projects board
  fields. (Third-party blog, not checked.)
FACTS

git add -A
git diff --cached --quiet || git commit -qm "eval fixture: a tracker move with a heavy migration"
