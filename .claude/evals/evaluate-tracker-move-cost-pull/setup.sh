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

# Run only inside a fixture checkout. A `.git` file means a linked worktree,
# whose config is shared with every other worktree; any other HEAD than the
# pinned commit means a real clone. Either way the steps below would rewrite
# someone's repository.
if [ -f .git ]; then
  echo "setup.sh: refusing to run in a linked worktree" >&2
  exit 1
fi
if [ -d .git ] && [ "$(git rev-parse HEAD 2>/dev/null)" != "7eb6c184837c36be9c9985a9dd11810bbb000779" ]; then
  echo "setup.sh: HEAD is not the pinned fixture commit" >&2
  exit 1
fi

# The fixture repo carries copies of skills that `exclude` in scenario.json
# does not strip. Delete them. The plugin variant supplies `.claude/skills/`.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json

git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

if [ ! -d .git ]; then
  git init -q
  git config user.email "eval@example.invalid"
  git config user.name "Tessl Eval"
fi

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

# The harness injects the plugin as symlinks under `.claude/` and `.agents/`,
# and only into the with-context variant. Ignore them in both variants so the
# no-edits check measures the agent, not the harness. `EVALUATION.md` is the
# deliverable and is NOT ignored.
mkdir -p .git/info
printf '.claude/\n.agents/\n' >> .git/info/exclude

git add -A
git diff --cached --quiet || git commit -qm "eval fixture: a tracker move with a heavy migration"
