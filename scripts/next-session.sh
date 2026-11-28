#!/usr/bin/env bash
# Opens a fresh Claude Code session for the next phase of a multi-phase project.
#
#   bash scripts/next-session.sh <handoff-file> [label]
#
# The handoff file holds everything the next session needs; the new session's
# first prompt only points at it. With Rex running (REX_SERVER set), the script
# opens a new Rex session in the handoff file's directory running `claude`, and
# prints its session id. Without Rex, it prints the fish command for the owner
# to paste, and exits 2 so the caller knows no session was started.
set -euo pipefail

handoff="${1:-}"
if [ -z "$handoff" ] || [ ! -f "$handoff" ]; then
  echo "usage: bash scripts/next-session.sh <handoff-file> [label]" >&2
  echo "the handoff file must exist" >&2
  exit 1
fi

dir="$(cd "$(dirname "$handoff")" && pwd)"
file="$dir/$(basename "$handoff")"
label="${2:-$(basename "$handoff" .md | tr '[:upper:]' '[:lower:]')}"

if ! grep -qE '^## Next phase' "$file"; then
  echo "$file has no '## Next phase' section; write the handoff first" >&2
  exit 1
fi

# No single quotes: the fallback wraps this in single quotes for fish.
prompt="Read $file first. It is the handoff from the session that ran the previous phase. Do the one phase its Next phase section names, then stop and hand off as the one-phase-per-session rule in AGENTS.md says."

if [ -n "${REX_SERVER:-}" ] && command -v rex >/dev/null 2>&1 && command -v claude >/dev/null 2>&1; then
  created="$(rex new "$label" -c "$dir" --keep-open --json -- claude "$prompt")"
  printf '%s\n' "$created" | grep -m1 '"session_id"' | sed -E 's/.*"(session:[^"]+)".*/started \1/'
  exit 0
fi

echo "No Rex here; paste this into a terminal (fish):"
echo "cd '$dir'; and claude '$prompt'"
exit 2
