#!/usr/bin/env bash
# Wait for a pull request's checks to reach a terminal state, then print one
# line and exit. Read by orchestrate Step 5 ("Every wait ends"), the shepherd
# agent and review-pr Step 7. Tested by scripts/tests/wait-pr.cli.test.ts.
#
#   bash scripts/wait-pr.sh <pr-number> [minutes]      # minutes defaults to 30
#
# Exit 0 — done: the pull request is MERGED or CLOSED, or it has checks, none
#          pending, and the same set on two polls running (a job that waits on
#          others registers only once they finish, so one quiet poll can come
#          too early). `cancel` and `skipping` show in the printed line.
# Exit 1 — needs action: it conflicts with its base (DIRTY, so no check will
#          run until a rebase), or a check failed.
# Exit 2 — no verdict: the deadline passed, or GitHub refused for rate. The line
#          gives the last state seen.
# Exit 3 — cannot answer: a bad argument, a pull request gh cannot resolve, or
#          a rejected login. Ends at once rather than at the deadline.
# An empty check list is not terminal: it is what a pull request shows between
# a push and its workflows registering. Any other gh failure counts as "no
# answer yet", so a network outage ends at the deadline.
#
# One GraphQL request per poll reads the state, the merge state and the check
# rollup; `gh pr checks` (two requests) runs only once the rollup has settled.
# bash, not fish: the Bash tool's shell is fish locally. macOS has no `timeout`
# binary, so the deadline is kept with $SECONDS. The Bash tool caps a
# foreground call at ten minutes, so run this with `run_in_background`, or in a
# Monitor whose `timeout_ms` is longer than the deadline.
set -u

usage() {
  echo "usage: wait-pr.sh <pr-number> [minutes]   (WAIT_PR_REPO=<owner>/<name> to change repository)" >&2
  exit 3
}

pr=${1:-}
minutes=${2:-30}
repo=${WAIT_PR_REPO:-englishstreetventures/osn}
# Whole numbers only: both reach arithmetic, which would evaluate anything else.
case "$pr" in '' | *[!0-9]*) usage ;; esac
case "$minutes" in '' | *[!0-9]*) usage ;; esac
case "$repo" in */*) ;; *) usage ;; esac
owner=${repo%%/*}
name=${repo#*/}

query='query($o:String!,$name:String!,$n:Int!){repository(owner:$o,name:$name){pullRequest(number:$n){state mergeStateStatus commits(last:1){nodes{commit{statusCheckRollup{state}}}}}}}'
shape='.data.repository.pullRequest | "\(.state) \(.mergeStateStatus) \(.commits.nodes[0].commit.statusCheckRollup.state // "NONE")"'
buckets='[.[].bucket] | group_by(.) | map("\(.[0])=\(length)") | join(" ")'

errfile=$(mktemp "${TMPDIR:-/tmp}/wait-pr.XXXXXX") || exit 3
trap 'rm -f "$errfile"' EXIT

deadline=$((SECONDS + minutes * 60))
last="no answer from gh yet"
settled=""

while :; do
  if view=$(gh api graphql -f o="$owner" -f name="$name" -F n="$pr" -f query="$query" --jq "$shape" 2>"$errfile"); then
    last="pr $pr: $view"
  else
    why=$(tr '\n' ' ' <"$errfile" | cut -c1-300)
    case "$why" in
      *"Could not resolve to a PullRequest"* | *"HTTP 401"* | *"gh auth login"*)
        echo "cannot answer: $why"
        exit 3
        ;;
      *"rate limit"*)
        echo "rate limited: $why — last seen: $last"
        exit 2
        ;;
    esac
    view=""
  fi

  read -r state merge rollup <<<"$view"
  case "${state:-}" in
    MERGED | CLOSED) echo "terminal: $last"; exit 0 ;;
  esac
  if [ "${state:-} ${merge:-}" = "OPEN DIRTY" ]; then
    echo "terminal: conflicts with its base — $last"
    exit 1
  fi

  case "${rollup:-}" in
    SUCCESS | FAILURE | ERROR)
      checks=$(gh pr checks "$pr" --repo "$repo" --json bucket --jq "$buckets" 2>/dev/null)
      last="pr $pr: $view · checks: ${checks:-none yet}"
      case " $checks " in
        *" fail="*) echo "terminal: a check failed — $last"; exit 1 ;;
        "  " | *" pending="*) settled="" ;;
        *)
          if [ "$checks" = "$settled" ]; then
            echo "terminal: no check pending — $last"
            exit 0
          fi
          settled=$checks
          ;;
      esac
      ;;
    *) settled="" ;;
  esac

  if [ "$SECONDS" -ge "$deadline" ]; then
    echo "timeout after $minutes min — last seen: $last"
    exit 2
  fi
  sleep 30
done
