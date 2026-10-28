#!/usr/bin/env bash
# Plant a small visual change that needs a value the design system does not have.
#
# The change is one line on a Musubi Social screen: a pending-verification badge
# should be amber, a colour musubi/social/DESIGN.md does not hold. The DESIGN.md
# names one chromatic colour, the destructive red, and no warning or amber
# token. The line reads as a mechanical edit and is not one: adding a colour
# the system lacks is a design decision, so pick-agent must send it to the
# designer tier, never to design-mechanic (which only applies a value the system
# already settles) and never to mechanic (which does not load the design system).
#
# The fixture plants the eight agent names with their one-line descriptions and
# NOTHING ELSE — no model, no effort level. That is what a dispatcher has
# without the skill, and it keeps both arms able to answer rather than making
# the choice a test of whether the plugin was loaded.
set -euo pipefail

# `claude plugin eval --scaffold` runs this in a fresh, empty workspace. Refuse
# anywhere else: every step below rewrites the repository it finds.
if [ -n "$(ls -A)" ]; then
  echo "setup.sh: the workspace is not empty; run only under claude plugin eval --scaffold" >&2
  exit 1
fi

# The pinned commit, shallow, so the fetch fits the scaffold's time limit.
git init -q
git fetch -q --depth 1 https://github.com/englishstreetventures/osn.git 2de3a8376b5772acaa4ebe91a6c5f40fdc917108
git checkout -q FETCH_HEAD
git config user.email "eval@example.invalid"
git config user.name "Claude Eval"

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

cat > TASK-ISSUE.md <<'ISSUE'
# englishstreetventures/osn — Pending verification needs a status colour

**Type:** Feature
**Labels:** `product:musubi`, `area:frontend`

**What** — On Musubi Social, an account that has not finished verification
shows a "Pending verification" badge. Today the badge uses the neutral grey
ink, so it looks the same as a label that needs nothing from the person. Make
the badge amber so it reads as waiting on the person.

**Why** — A person who sees "Pending verification" in grey does not know it
needs an action. Amber is the status colour most people already read as
"needs attention", and the badge is the only place that state is shown.

**Done when** — The pending badge is amber in light and dark themes, and reads
clearly at the badge's 12px size.

**Notes** — The change is a single class on a single element. The design
system has no amber or warning colour today: its only chromatic colour is the
destructive red, which is reserved for removing or deleting.
ISSUE

# Name and one-line description only. Deliberately no model and no effort
# level: the skill under test sends the agent to `.claude/agents/<name>.md` for
# those, and only the plugin supplies that directory.
cat > AGENTS-AVAILABLE.md <<'AGENTS'
# Subagent definitions available in this repository

- **attacker** — Reads a plan cold and tries to break it. A fresh context on
  purpose, so it cannot agree with the author out of habit. Dispatched by
  stress-plan; never the agent that wrote the plan.
- **design-mechanic** — Small visual changes whose answer the surface's
  DESIGN.md or design wiki page already settles — a token swap, spacing or a
  type step on the existing scale, a missing dark-mode value, a component
  variant that already exists. Loads the design-system skill first. Anything
  that needs a design decision goes to designer.
- **designer** — Owns one UI task that needs a design decision — a new page or
  component, a layout, a redesign, a token the design system does not have yet
  — from plan to a result someone has seen rendered. Loads the design-system
  skill before touching a file. A small visual change the surface's DESIGN.md
  already settles goes to design-mechanic; UI logic with no visual change goes
  to implementer; a design audit that changes nothing goes to reviewer.
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
- **reviewer** — Reviews one branch through one lens — tests, security,
  performance, docs, or a whole branch against its plan — and reports findings.
  Never fixes what it finds. Dispatched by prep-pr for its review skills, and
  by any skill or plugin that asks for a review subagent.
- **shepherd** — Watches a pull request to a terminal state — polls CI and
  reports what went red. Never merges, rebases, pushes or removes a worktree.
  Exists so slow polling does not sit in an expensive context.
AGENTS

git add -A
git diff --cached --quiet || git commit -qm "eval fixture: a status colour the design system lacks"
