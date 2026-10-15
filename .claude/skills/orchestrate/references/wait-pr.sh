#!/usr/bin/env bash
# Wait for a pull request's checks to reach a terminal state, then print one
# line and exit. Read by orchestrate Step 5 ("Every wait ends"), the shepherd
# agent and review-pr Step 6.
#
#   bash .claude/skills/orchestrate/references/wait-pr.sh <pr> [minutes]
#
# Terminal: the pull request is MERGED or CLOSED (exit 0); it conflicts with its
# base, `DIRTY`, where no check will run until it is rebased (exit 1); any check
# in the `fail` bucket (exit 1); at least one check and none `pending` (exit 0,
# the line counts each bucket, so `cancel` and `skipping` show). No checks at
# all is not terminal: straight after a push the list is empty until the
# workflows register. At the deadline (default 30 minutes) it prints the last state it saw
# and exits 2. A failed `gh` call counts as "no answer yet", so a network
# outage ends at the deadline rather than looping.
#
# bash, not fish: the Bash tool's shell is fish locally. macOS has no `timeout`
# binary, so the deadline is kept with $SECONDS. The Bash tool caps a
# foreground call at ten minutes, so run this with `run_in_background`, or as a
# Monitor whose `timeout_ms` is longer than the deadline.
set -u

pr=${1:?usage: wait-pr.sh <pr> [minutes]}
minutes=${2:-30}
repo=${REPO:-englishstreetventures/osn}
deadline=$((SECONDS + minutes * 60))
last="no answer from gh yet"

while :; do
  view=$(gh pr view "$pr" --repo "$repo" --json state,mergeStateStatus \
    --jq '"\(.state) \(.mergeStateStatus)"' 2>/dev/null)
  checks=$(gh pr checks "$pr" --repo "$repo" --json bucket \
    --jq '[.[].bucket] | group_by(.) | map("\(.[0])=\(length)") | join(" ")' 2>/dev/null)
  [ -n "$view$checks" ] && last="pr $pr: ${view:-state unknown} · checks: ${checks:-none yet}"

  case "$view" in
    MERGED* | CLOSED*) echo "terminal: $last"; exit 0 ;;
    "OPEN DIRTY") echo "terminal: conflicts with its base — $last"; exit 1 ;;
  esac
  case " $checks " in
    *" fail="*) echo "terminal: a check failed — $last"; exit 1 ;;
    "  " | *" pending="*) ;;
    *) echo "terminal: no check pending — $last"; exit 0 ;;
  esac

  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timeout after $minutes min — last seen: $last"
    exit 2
  fi
  sleep 30
done
