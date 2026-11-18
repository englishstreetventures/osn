#!/usr/bin/env bash
# CI's Scripts and browser test steps (the `script-tests` and `browser` jobs in
# .github/workflows/ci.yml): runs a test command once, and when the run fails,
# runs the whole command again, at most <attempts> runs, each cut at
# <seconds>, through scripts/retry.sh. A run that passes is never run again.
#
# usage: test-with-retry.sh <attempts> <seconds> <label> <command> [args...]
#   CI:  test-with-retry.sh 2 300 Scripts bun run test:scripts
#
# The whole command, never one test: each run starts its processes afresh, so
# a browser test file gets a new page. A test run again inside the page it
# failed in starts from what its first run left there (a loaded module, a
# request route, the pointer, the DOM) and can fail or pass for that alone
# (wiki/conventions/browser-tests.md, "A test run twice in one page"). Under
# turbo, the second run replays each package that passed from turbo's cache,
# so only a package that failed runs again.
#
# Each run's output goes to the step's log and to a file under $RUNNER_TEMP.
# A pass after a failed run is a flake, and stays visible: the script prints a
# ::warning:: naming <label>, the failed runs and the lines of their output
# that name a failing test, and adds the same to $GITHUB_STEP_SUMMARY. Those
# lines are found by plain text once colour codes are stripped: bun test's
# "(fail) ", and Vitest's " FAIL " and " × ". At most 40 are shown, and the
# warning says how many there were. A step whose runs all failed gets a
# summary of the last run's lines; retry.sh prints its ::error::.
#
# Exit: retry.sh's. 0 when a run passes, otherwise the last run's status (124
# or 137 when it was cut at the limit); 2 for a usage error, before anything
# runs.
#
# Tests: scripts/tests/test-with-retry.cli.test.ts.
set -uo pipefail

SHOWN=40

usage() {
  echo "usage: test-with-retry.sh <attempts> <seconds> <label> <command> [args...]" >&2
  exit 2
}

# One run, as retry.sh's command: the command, its output to the step's log
# and to <dir>/run-<n>.log, where <n> counts the runs this invocation has
# started.
if [ "${1:-}" = "--run" ]; then
  [ $# -ge 3 ] || usage
  dir=$2
  shift 2
  n=$(($(cat "$dir/runs") + 1))
  echo "$n" >"$dir/runs"
  "$@" 2>&1 | tee "$dir/run-$n.log"
  exit "${PIPESTATUS[0]}"
fi

whole() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
}

[ $# -ge 4 ] || usage
attempts=$1
seconds=$2
label=$3
shift 3
if ! whole "$attempts" || ! whole "$seconds" || [ -z "$label" ]; then usage; fi
if [ "$attempts" -lt 1 ] || [ "$seconds" -lt 1 ]; then usage; fi

self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
retry="$(dirname "$self")/retry.sh"

dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/test-with-retry.XXXXXX")
trap 'rm -rf "$dir"' EXIT
echo 0 >"$dir/runs"

bash "$retry" "$attempts" "$seconds" bash "$self" --run "$dir" "$@"
status=$?
runs=$(cat "$dir/runs")

[ "$runs" -gt 1 ] || exit "$status"

esc=$(printf '\033')

# The lines of the named logs that name a failing test: carriage returns and
# colour codes stripped, runs of space made one, each line once, in order.
failing() {
  cat "$@" 2>/dev/null |
    LC_ALL=C tr -d '\r' |
    LC_ALL=C sed "s/$esc\[[0-9;]*[A-Za-z]//g" |
    LC_ALL=C grep -E '\(fail\) |(^|[[:space:]])FAIL |(^|[[:space:]])× ' |
    LC_ALL=C sed 's/[[:space:]][[:space:]]*/ /g; s/^ //' |
    LC_ALL=C awk '!seen[$0]++'
}

# Text as a workflow command's data: GitHub reads %, CR and LF there as
# escapes and line ends, so they are escaped and the annotation stays one line.
data() {
  local text=$1
  text=${text//'%'/%25}
  text=${text//$'\r'/%0D}
  text=${text//$'\n'/%0A}
  printf '%s' "$text"
}

# The runs whose output is read: the failed ones before a pass, or the last.
if [ "$status" -eq 0 ]; then
  if [ "$runs" -eq 2 ]; then
    which="run 1"
  else
    which="runs 1 to $((runs - 1))"
  fi
  logs=()
  for i in $(seq 1 $((runs - 1))); do logs+=("$dir/run-$i.log"); done
else
  which="run $runs"
  logs=("$dir/run-$runs.log")
fi
failing "${logs[@]}" >"$dir/failing"
found=$(wc -l <"$dir/failing" | tr -d ' ')
lines=$(head -n "$SHOWN" "$dir/failing")

if [ "$found" -eq 0 ]; then
  named="The output of $which is in this step's log, and no line of it names a failing test."
elif [ "$found" -gt "$SHOWN" ]; then
  named="Lines of the output of $which that name a failing test, the first $SHOWN of $found:"
else
  named="Lines of the output of $which that name a failing test:"
fi
fence='```'
block=""
if [ "$found" -gt 0 ]; then
  block=$'\n'"${fence}text"$'\n'"$lines"$'\n'"$fence"
fi
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

if [ "$status" -eq 0 ]; then
  message="$label passed on run $runs of $attempts after $which failed. A test that fails only sometimes is still a bug. $named"
  [ "$found" -eq 0 ] || message="$message"$'\n'"$lines"
  echo "::warning::$(data "$message")"
  {
    echo "### $label passed on run $runs of $attempts"
    echo
    echo "$(echo "${which:0:1}" | tr '[:lower:]' '[:upper:]')${which:1} failed first. A test that fails only sometimes is still a bug. $named"
    echo "$block"
  } >>"$summary"
else
  if [ "$runs" -eq 2 ]; then
    all="both runs failed"
  else
    all="all $runs runs failed"
  fi
  {
    echo "### $label: $all"
    echo
    echo "$named"
    echo "$block"
  } >>"$summary"
fi
exit "$status"
