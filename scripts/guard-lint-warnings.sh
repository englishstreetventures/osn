#!/usr/bin/env bash
# Guard the count of `bun run lint` warning-severity diagnostics across the
# whole monorepo, so a branch that adds one can't stay green.
#
# @see wiki/conventions/bundle-size-guards.md — the two rules this guard
# follows (one committed file for the number; headroom smaller than the
# smallest mistake it exists to catch) and why the headroom here is zero in
# both directions, making this a ratchet rather than a one-way cap: a count
# BELOW the ceiling fails too, with a message to lower the file, so a
# cleanup's slack can't let the count drift back up unnoticed.
#
# Usage:
#   guard-lint-warnings.sh          # what ci.yml's `lint` job calls, as its
#                                     own step after the existing `bun run
#                                     lint` step (so "a rule errored" and
#                                     "the count moved" read as two different
#                                     failures)
#
# Counting method: oxlint's human-readable output (what `bun run lint`
# prints) has no summary line in the pinned version — confirmed by running
# `bun run lint | tail` and `bun run lint | grep -c "Found \|Finished in "`
# (zero matches) rather than inferred from the JSON output, which says
# nothing about a separate code path. Grepping the word "warning" over that
# output would also match it appearing inside a rule's own message or a file
# path. `--format=json` instead gives one object per diagnostic with an
# explicit `"severity": "warning" | "error"` field, stamped by oxlint itself
# — filtering on that field is exact regardless of message wording or output
# layout. scripts/lint-warning-count.ts does the counting (unit-tested
# against a fixture report in scripts/tests/lint-warning-count.test.ts);
# this script owns running the real oxlint, reading the ceiling file, and
# the pass/fail decision.
#
# LINT_WARNING_CEILING_FILE overrides the ceiling file path, LINT_WARNING_ROOT
# overrides the directory oxlint runs in (real usage: the repo root, matching
# `bun run lint`'s own "."), and LINT_WARNING_OXLINT_BIN overrides the oxlint
# binary path (default: LINT_WARNING_ROOT's own node_modules/.bin/oxlint —
# the same binary `bun run lint` resolves to on this checkout's PATH).
# scripts/tests/guard-lint-warnings.test.sh uses all three to point this
# script at a small fixture project instead of the real monorepo, while
# still running the REAL oxlint binary from this checkout's own node_modules.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CEILING_FILE="${LINT_WARNING_CEILING_FILE:-$SCRIPT_DIR/lint-warning-ceiling.txt}"
LINT_ROOT="${LINT_WARNING_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OXLINT_BIN="${LINT_WARNING_OXLINT_BIN:-$LINT_ROOT/node_modules/.bin/oxlint}"

if [ ! -f "$CEILING_FILE" ]; then
  echo "::error::guard-lint-warnings.sh: ceiling file not found: ${CEILING_FILE} — refusing to run rather than pass with nothing to check the count against." >&2
  exit 1
fi

# One non-negative integer, alone on the first non-blank, non-comment line
# (the same `#`-comment convention as bundle-size-budgets.txt). Fails closed
# on anything else — a malformed file stops the guard rather than silently
# parsing to 0 or to the wrong token.
ceiling=""
while IFS= read -r line || [ -n "$line" ]; do
  stripped="${line%%#*}"
  stripped="$(printf '%s' "$stripped" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  [ -z "$stripped" ] && continue
  ceiling="$stripped"
  break
done <"$CEILING_FILE"

if [ -z "$ceiling" ] || ! [[ "$ceiling" =~ ^[0-9]+$ ]]; then
  echo "::error::guard-lint-warnings.sh: ${CEILING_FILE} does not hold a single non-negative integer ceiling on its first non-comment line — refusing to run." >&2
  exit 1
fi

if [ ! -x "$OXLINT_BIN" ]; then
  echo "::error::guard-lint-warnings.sh: oxlint binary not found or not executable at ${OXLINT_BIN} — run \`bun install\` first." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Same invocation `bun run lint` makes (oxlint -c oxlintrc.json .), plus
# --format=json, run from LINT_ROOT so relative paths in the config and the
# "." target resolve exactly the way they do for that script.
set +e
(cd "$LINT_ROOT" && "$OXLINT_BIN" -c oxlintrc.json . --format=json) >"$WORK_DIR/oxlint.json" 2>"$WORK_DIR/oxlint.stderr"
oxlint_exit=$?
set -e

if [ "$oxlint_exit" -ne 0 ]; then
  echo "::error::guard-lint-warnings.sh: oxlint exited with status ${oxlint_exit} — an error-level rule fired, not just warnings. Run \`bun run lint\` to see it; this guard only checks the warning count and cannot make a meaningful comparison while lint itself is failing." >&2
  cat "$WORK_DIR/oxlint.stderr" >&2
  exit 1
fi

result_file="$WORK_DIR/result.txt"
bun "$SCRIPT_DIR/lint-warning-count.ts" "$WORK_DIR/oxlint.json" >"$result_file"

# lint-warning-count.ts exits non-zero on every failure it can hit (unreadable
# file, invalid JSON), and `set -e` above would already have stopped this
# script before this line ran in that case — so this branch is unreachable
# through either of this script's own call sites today. Left in as defence
# in depth against a future change to that script that prints something
# non-numeric on its first line while still exiting 0, the same shape as
# guard-bundle-size.sh's own unreachable-mode arm.
count="$(head -n1 "$result_file")"
if ! [[ "$count" =~ ^[0-9]+$ ]]; then
  echo "::error::guard-lint-warnings.sh: could not determine a warning count from oxlint's output." >&2
  exit 1
fi

if [ "$count" -eq "$ceiling" ]; then
  echo "guard-lint-warnings.sh: ${count} lint warnings, matches the ceiling in ${CEILING_FILE}."
  exit 0
fi

if [ "$count" -gt "$ceiling" ]; then
  delta=$((count - ceiling))
  echo "::error::guard-lint-warnings.sh: ${count} lint warnings exceeds the ceiling of ${ceiling} in ${CEILING_FILE} by ${delta}. This branch added at least one new warning. Warnings by rule (highest first):" >&2
  tail -n +2 "$result_file" | sed 's/^/  /' >&2
  echo "Run \`bun run lint\` locally to see file:line locations for the rule(s) above. If the new warning(s) are intentional, edit ONLY ${CEILING_FILE} and set it to ${count}." >&2
  exit 1
fi

delta=$((ceiling - count))
echo "::error::guard-lint-warnings.sh: ${count} lint warnings is below the ceiling of ${ceiling} in ${CEILING_FILE} by ${delta}. Warnings were fixed — good — but the ceiling has to ratchet down with them, or the count can silently drift back up before anything notices. Edit ONLY ${CEILING_FILE} and set it to ${count}." >&2
exit 1
