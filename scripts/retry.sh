#!/usr/bin/env bash
# Runs a command until it passes, at most <attempts> times, each attempt cut at
# <seconds>. For a CI step that fails on the network or the runner rather than
# on the change, such as an apt mirror that stalls part way through a download.
#
# usage: retry.sh [-k <grace>] <attempts> <seconds> <command> [args...]
#
# At the limit every process of the attempt gets SIGTERM, then SIGKILL <grace>
# seconds later (default 10) if it is still running. When an attempt ends, by
# itself or at the limit, anything it started that is still running is killed
# before the next attempt starts, so nothing left over holds a lock against it.
# Each attempt runs in a process group of its own, so the script must not be a
# command's only way to reach a terminal.
#
# Exit: 0 when an attempt passes; otherwise the last attempt's status (124 or
# 137 when it was cut at the limit); 2 for a usage error, before anything runs.
# Each failed attempt prints a ::warning:: naming it and why it failed, and the
# script prints an ::error:: when the last one fails; the command line in them
# is escaped as workflow-command data.
#
# Tests: scripts/tests/retry.cli.test.ts.
set -uo pipefail

usage() {
  echo "usage: retry.sh [-k <grace>] <attempts> <seconds> <command> [args...]" >&2
  exit 2
}

whole() {
  case "$1" in
    '' | *[!0-9]*) return 1 ;;
  esac
}

grace=10
if [ "${1:-}" = "-k" ]; then
  [ $# -ge 2 ] || usage
  grace=$2
  shift 2
fi
[ $# -ge 3 ] || usage
attempts=$1
seconds=$2
shift 2
if ! whole "$attempts" || ! whole "$seconds" || ! whole "$grace"; then usage; fi
if [ "$attempts" -lt 1 ] || [ "$seconds" -lt 1 ]; then usage; fi

# The command line as a workflow command's data: GitHub reads %, CR and LF
# there as escapes and line ends, so they are escaped and each annotation
# stays on its one line.
shown=$*
shown=${shown//%/%25}
shown=${shown//$'\r'/%0D}
shown=${shown//$'\n'/%0A}

# Job control puts each background job in a process group whose id is its pid,
# so whatever an attempt leaves behind can be found and killed as a group.
set -m

status=0
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  timeout -k "$grace" "$seconds" "$@" &
  group=$!
  wait "$group"
  status=$?
  # Anything of the attempt still running, then wait (10 s at most) until the
  # group is gone, so the next attempt starts on its own.
  kill -KILL -- "-$group" 2>/dev/null
  for _ in $(seq 1 100); do
    kill -0 -- "-$group" 2>/dev/null || break
    sleep 0.1
  done
  [ "$status" -eq 0 ] && exit 0
  case "$status" in
    124 | 137) why="was cut at its $seconds s limit" ;;
    *) why="exited $status" ;;
  esac
  echo "::warning::retry.sh: attempt $attempt of $attempts of '$shown' $why"
  attempt=$((attempt + 1))
done
echo "::error::retry.sh: '$shown' failed all $attempts attempts"
exit "$status"
