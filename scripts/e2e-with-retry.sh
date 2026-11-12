#!/usr/bin/env bash
# CI's E2E step (the `E2E` job in .github/workflows/ci.yml): runs the
# end-to-end suite, and when a run fails, runs the whole suite again, at most
# <attempts> runs, each cut at <seconds>, through scripts/retry.sh.
#
# usage: e2e-with-retry.sh <attempts> <seconds> <command> [args...]
#   CI:  e2e-with-retry.sh 2 720 bun run test:e2e
#
# The whole run, never one flow: each run boots the stack afresh, on newly
# seeded databases with empty in-memory rate-limit windows. The flows spend
# small windows that last the whole run (osn-api takes five sign-up begins a
# minute from the suite's one address, and sends one account three recovery
# links a day) and seeded state a flow can use once, so a flow retried inside
# the run it failed in can fail again for that alone. That is why
# tools/e2e/playwright.config.ts keeps Playwright's own retries at 0.
#
# The launcher clears e2e-artifacts/ as it starts, so before each run after
# the first this script moves the previous run's directory to
# e2e-artifacts-attempt-<n>/, which the job uploads under that name. The last
# run's stays in e2e-artifacts/. Directories an earlier invocation left are
# removed first, so none is taken for this one's.
#
# A pass after a failed run is a flake, and stays visible: the script prints a
# ::warning:: naming the failed runs and where their artifacts are, and adds
# the same to $GITHUB_STEP_SUMMARY. A step whose runs all failed gets a
# summary too; retry.sh prints its ::error::.
#
# Exit: retry.sh's. 0 when a run passes, otherwise the last run's status (124
# or 137 when it was cut at the limit); 2 for a usage error, before anything
# runs.
#
# Tests: scripts/tests/e2e-with-retry.cli.test.ts.
set -uo pipefail

ARTIFACTS=e2e-artifacts

usage() {
  echo "usage: e2e-with-retry.sh <attempts> <seconds> <command> [args...]" >&2
  exit 2
}

# One run, as retry.sh's command: the previous run's artifacts set aside, then
# the suite. <runs file> counts the runs this invocation has started.
if [ "${1:-}" = "--run" ]; then
  [ $# -ge 3 ] || usage
  runs_file=$2
  shift 2
  n=$(($(cat "$runs_file") + 1))
  echo "$n" >"$runs_file"
  if [ "$n" -gt 1 ] && [ -d "$ARTIFACTS" ]; then
    mv "$ARTIFACTS" "$ARTIFACTS-attempt-$((n - 1))"
  fi
  exec "$@"
fi

[ $# -ge 3 ] || usage
attempts=$1
seconds=$2
shift 2

self="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
retry="$(dirname "$self")/retry.sh"

rm -rf "$ARTIFACTS"-attempt-*
runs_file=$(mktemp)
echo 0 >"$runs_file"

bash "$retry" -k 30 "$attempts" "$seconds" bash "$self" --run "$runs_file" "$@"
status=$?
runs=$(cat "$runs_file")
rm -f "$runs_file"

[ "$runs" -gt 1 ] || exit "$status"

# The runs before the last, all failed, and the artifact each one's directory
# is uploaded as.
if [ "$runs" -eq 2 ]; then
  earlier="run 1"
  whose="run's"
else
  earlier="runs 1 to $((runs - 1))"
  whose="runs'"
fi
names=""
for i in $(seq 1 $((runs - 1))); do
  names="${names:+$names, }\`$ARTIFACTS-attempt-$i\`"
done
summary=${GITHUB_STEP_SUMMARY:-/dev/null}

if [ "$status" -eq 0 ]; then
  echo "::warning::E2E passed on run $runs of $attempts after $earlier failed. A flow that fails only sometimes is still a bug: the failed $whose traces, screenshots and logs are in ${names//\`/}."
  {
    echo "### E2E passed on run $runs of $attempts"
    echo
    echo "$(echo "${earlier:0:1}" | tr '[:lower:]' '[:upper:]')${earlier:1} failed first. The failed $whose traces, screenshots and logs are in $names; the passing run's are in \`$ARTIFACTS\`. A flow that fails only sometimes is still a bug."
  } >>"$summary"
else
  {
    echo "### E2E: all $runs runs failed"
    echo
    echo "The last run's traces, screenshots and logs are in \`$ARTIFACTS\`; the earlier $whose are in $names."
  } >>"$summary"
fi
exit "$status"
