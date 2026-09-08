#!/usr/bin/env bash
# Plant a task that reads as expensive and demands only reading.
#
# The issue asks for a `file:line` inventory of every route across the four
# APIs and the middleware that wraps each one. Every surface signal is heavy:
# auth, four packages, sixty-four route files, a wiki rewrite blocked behind it,
# and a repository whose own rubric sends "auth or session work" to the most
# capable definition there is. The issue also says, in its own words, that
# judging whether a gate is correct is a different issue.
#
# So the correct answer is the read-only definition on its own settings, and
# reaching it means matching on what the task produces rather than on the
# weight of its subject. Nothing here is mislabelled and nothing is a trick:
# the issue is honest, and the pull toward a code-writing agent comes entirely
# from the subject matter.
#
# The fixture plants the five agent names with their one-line descriptions and
# NOTHING ELSE — no model, no effort level. That is what a dispatcher has
# without the skill, and it keeps both variants able to answer rather than
# making the choice a test of whether the plugin was injected.
set -euo pipefail

# The fixture repo carries `.claude/commands/*.md` — verbatim copies of the
# skills, which `exclude` in scenario.json does not actually strip. Delete
# every copy. The plugin variant supplies `.claude/skills/` and
# `.claude/agents/`, which nothing here touches.
rm -rf .claude/commands .claude/projects .claude/evals .claude/tessl.json

git config user.email "eval@example.invalid" 2>/dev/null || true
git config user.name "Tessl Eval" 2>/dev/null || true

if [ ! -d .git ]; then
  git init -q
  git config user.email "eval@example.invalid"
  git config user.name "Tessl Eval"
fi

cat > TASK-ISSUE.md <<'ISSUE'
# xchromo/osn#951 — Inventory every API route and the gate that wraps it

**Type:** Task
**Labels:** `product:shared`, `area:docs`

**What** — A `file:line` inventory of every Elysia route across the four APIs
— `osn/api`, `pulse/api`, `zap/api`, `cire/api` — and, against each route, the
middleware that wraps it. Quote the shortest line that proves the gate.

**Why** — Blocks #952, the rewrite of `wiki/systems/cire-auth.md` and
`wiki/systems/identity-model.md`. Neither page can be trusted until we know
what the routes actually are; both were last reviewed before the vendor portal
shipped.

**Done when** — The inventory is on this issue: every route file, every route
in it, its gate, with line numbers.

**Explicitly not this issue** — Do not judge whether any gate is right, do not
change one, and do not touch the wiki. Whether a route is gated *correctly* is
#953, a security review, and it is deliberately a separate issue: folding the
judgement into the survey is how the last audit produced a page nobody could
check against the code.

**Notes** — It is a big read. `cire/api` alone has ten middleware files, and
the two-auth model means a route can be gated by a guest session cookie, by an
OSN access token, or by both. `osn/api` carries the OIDC provider surface on
top of its own routes.
ISSUE

# Name and one-line description only. Deliberately no model and no effort
# level: those are what the skill under test supplies.
cat > AGENTS-AVAILABLE.md <<'AGENTS'
# Subagent definitions available in this repository

- **attacker** — Reads a plan cold and tries to break it. A different model on
  purpose, so it cannot agree with the author out of habit. Dispatched by
  stress-plan; never the agent that wrote the plan.
- **explorer** — Read-only orientation. Finds where things live and returns
  file paths with line numbers — never a fix, never an opinion about what to
  change. Use before planning when the shape of the code is unknown.
- **implementer** — Owns one task end to end — plans it, writes it, tests it.
  The default for any subagent that will change code. Dispatched by orchestrate
  at Step 3, and by any skill handing off a whole unit of work.
- **mechanic** — Mechanical, well-specified changes where the answer is fixed
  before the work starts — patch and minor dependency bumps, renames,
  changesets, a pattern applied across files. Not for anything that needs a
  decision.
- **shepherd** — Watches a pull request to a terminal state — polls CI and
  reports what went red. Never merges, rebases, pushes or removes a worktree.
  Exists so slow polling does not sit in an expensive context.
AGENTS

# The harness injects the plugin as symlinks under `.claude/` and `.agents/`,
# and only into the with-context variant. Left visible they show up as working
# -tree changes in that variant alone, which the no-source-edits check then
# scores against it. Ignore them in both variants so the guard measures the
# agent, not the harness.
#
# `DISPATCH.md` is NOT excluded here. It is the deliverable, and hiding the one
# file the judge reads behind an ignore rule is how a scenario ends up scoring
# something other than the work.
mkdir -p .git/info
printf '.claude/\n.agents/\n' >> .git/info/exclude

git add -A
git diff --cached --quiet || git commit -qm "eval fixture: a survey that reads as an audit"
