#!/usr/bin/env bash
# Plant a small visual change whose answer the surface's DESIGN.md already holds.
#
# The change is one line: secondary text on a Musubi Social screen should take
# the muted-ink token that musubi/social/DESIGN.md names for secondary text. It
# reads as a mechanical edit, and it is not one: it changes how a screen looks,
# so pick-agent must send it to a design agent, never to mechanic, which does
# not load the design-system skill. Because DESIGN.md already settles the
# answer, the right tier is design-mechanic, not designer.
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
git config commit.gpgsign false
git config tag.gpgsign false

# The checkout's own skills and agents would hand the no-plugin arm the
# instructions under test. The plugin supplies them to the other arm.
rm -rf .claude .agents

cat > TASK-ISSUE.md <<'ISSUE'
# englishstreetventures/osn — Connected apps: secondary text uses the wrong ink token

**Type:** Bug
**Labels:** `product:musubi`, `area:frontend`

**What** — On the Connected apps section of Musubi Social, the one-line
description under the section heading is set in the lighter `text-subtle`
grey. The design system gives secondary text its own token, and the rest of
the screen's subtitles already use it. The description should match them.

**Why** — The lighter grey makes the description read as a disabled control
rather than as copy. Every other subtitle on the screen uses the secondary ink
token, so this one line is the only place the screen disagrees with itself.

**Done when** — The description uses the same ink token as the other subtitles
on the screen, in light and dark themes, and nothing else on the screen changes.

**Notes** — The change is a single class on a single element. The design system
already names the token for this role, so no new colour is needed.
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
git diff --cached --quiet || git commit -qm "eval fixture: a settled token on a secondary label"
