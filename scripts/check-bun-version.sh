#!/usr/bin/env bash
# Warn when the Bun on PATH is not the version `.bun-version` pins.
#
# CI installs the pinned Bun (`bun-version-file: .bun-version` in every
# workflow; the migration history check reads `main`'s pin), so a test that
# fails locally on Bun's own wording or behaviour is green there, and the
# failure looks like a regression on main. The
# SessionStart hook in .claude/settings.json runs this script, and Claude Code
# puts what it prints into the session's context, so the session hears about
# the skew before it trusts such a failure.
#
# Prints nothing when the versions match. Always exits 0: a warning must never
# stop a session from starting. Prints no install command, because an agent
# reading this could run it and change the Bun every worktree uses; the
# setup-osn skill owns installing the pin.

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
pinned="$(tr -d '[:space:]' <"$root/.bun-version" 2>/dev/null)"
[ -n "$pinned" ] || exit 0

if ! running="$(bun --version 2>/dev/null)"; then
  echo "Bun is not on PATH. This repository pins Bun $pinned (.bun-version); no script or test here runs without it. The setup-osn skill covers installing it."
  exit 0
fi

if [ "$running" != "$pinned" ]; then
  echo "Bun version skew: \`bun --version\` prints $running, but .bun-version pins $pinned, the version CI runs. A test failure that names no code you touched may come from the skew rather than a regression: rerun it under Bun $pinned before you believe it, and say which Bun ran in any report. Do not change the installed Bun without the user's say-so; the setup-osn skill covers installing the pin."
fi
exit 0
