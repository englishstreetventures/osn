#!/usr/bin/env bash
# Guard the count of `bun run lint` warning-severity diagnostics across the
# whole monorepo, so a branch that adds one can't stay green — without making
# every branch that removes one edit the shared ceiling line.
#
# @see wiki/conventions/bundle-size-guards.md — the two rules this guard
# follows (one committed file for the number; headroom smaller than the
# smallest mistake it exists to catch) and how the ceiling moves.
#
# Usage:
#   guard-lint-warnings.sh                 # the absolute check: fail when the
#                                          # count is above the ceiling. What
#                                          # ci.yml's `lint` job runs on a push
#                                          # to main.
#   guard-lint-warnings.sh --base <rev>    # the absolute check, plus: fail
#                                          # when this tree has more warnings
#                                          # than <rev>, beyond any raise of
#                                          # the ceiling it makes. What ci.yml
#                                          # runs on a pull request, with
#                                          # HEAD^1 (the base the merge commit
#                                          # was made against). Locally:
#                                          # --base "$(git merge-base origin/main HEAD)"
#   guard-lint-warnings.sh --count         # print the count alone on stdout.
#                                          # What release.yml's `lint-count`
#                                          # job runs on main.
#   guard-lint-warnings.sh --lower-to <n>  # set the ceiling to <n> when <n> is
#                                          # lower; never raise it. What
#                                          # release.yml's `release` job runs
#                                          # with that count.
#
# A count below the ceiling passes: a branch that removes warnings leaves the
# ceiling file alone, and release.yml lowers it on main after the merge, in
# the same commit as the version bumps. That is what lets two such branches
# merge in either order with no conflict on the ceiling line. The ceiling
# lags main's count between a merge and that commit, so the absolute check
# alone would let a branch measured in the gap add warnings up to the slack;
# --base closes that by holding every pull request to its own base instead.
#
# --base measures <rev> with <rev>'s own toolchain: its tree is written out
# through a temporary index (nothing in the working tree, the real index or
# the worktree list changes), its own dependencies are installed there with
# `bun install --frozen-lockfile --ignore-scripts`, and its own oxlint runs
# with its own oxlintrc.json. A branch that bumps oxlint or a lint plugin is
# therefore compared old tools against new, so warnings the bump adds count
# as warnings the branch adds. A tree with no package.json (the test
# fixtures) is linted with LINT_WARNING_OXLINT_BIN instead.
#
# A deliberate raise: set the value line to the number the failure names and
# put your branch and date in its trailing comment, so two raises at once
# conflict as text instead of merging to one number. --base allows exactly
# the raise a branch makes: this tree may hold the base's count plus
# (this tree's ceiling minus the base's ceiling).
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
# script at small fixture projects and repositories instead of the real
# monorepo, while still running the REAL oxlint binary from this checkout's
# own node_modules.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CEILING_FILE="${LINT_WARNING_CEILING_FILE:-$SCRIPT_DIR/lint-warning-ceiling.txt}"
LINT_ROOT="${LINT_WARNING_ROOT:-$(cd "$SCRIPT_DIR/.." && pwd)}"
OXLINT_BIN="${LINT_WARNING_OXLINT_BIN:-$LINT_ROOT/node_modules/.bin/oxlint}"

usage() {
  echo "::error::guard-lint-warnings.sh: $1 Usage: guard-lint-warnings.sh [--base <rev> | --count | --lower-to <n>]" >&2
  exit 1
}

mode="check"
base_rev=""
lower_to=""
case "${1:-}" in
  "") ;;
  --base)
    { [ $# -ge 2 ] && [ -n "$2" ]; } || usage "--base needs a revision to compare with."
    mode="base"
    base_rev="$2"
    shift 2
    ;;
  --count)
    mode="count"
    shift
    ;;
  --lower-to)
    { [ $# -ge 2 ] && [ -n "$2" ]; } || usage "--lower-to needs the measured count."
    mode="lower"
    lower_to="$2"
    shift 2
    ;;
  *) usage "unknown argument '$1'." ;;
esac
[ $# -eq 0 ] || usage "unexpected argument '$1'."

plural() {
  if [ "$1" -eq 1 ]; then printf '%s warning' "$1"; else printf '%s warnings' "$1"; fi
}

# One non-negative integer, alone on the first non-blank, non-comment line
# (the same `#`-comment convention as bundle-size-budgets.txt). Sets
# parsed_value and parsed_line. Returns 1 when the file is missing and 2 when
# that line is anything but an integer — a malformed file stops the guard
# rather than silently parsing to 0 or to the wrong token.
parse_ceiling() {
  local file="$1" line stripped n=0
  parsed_value=""
  parsed_line=0
  [ -f "$file" ] || return 1
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    stripped="${line%%#*}"
    stripped="$(printf '%s' "$stripped" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
    [ -z "$stripped" ] && continue
    parsed_value="$stripped"
    parsed_line=$n
    break
  done <"$file"
  { [ -n "$parsed_value" ] && [[ "$parsed_value" =~ ^[0-9]+$ ]]; } || return 2
  parsed_value=$((10#$parsed_value))
}

# Sets ceiling and ceiling_line from CEILING_FILE, or stops the guard.
load_ceiling() {
  local status=0
  parse_ceiling "$CEILING_FILE" || status=$?
  case "$status" in
    0) ;;
    1)
      echo "::error::guard-lint-warnings.sh: ceiling file not found: ${CEILING_FILE} — refusing to run rather than pass with nothing to check the count against." >&2
      exit 1
      ;;
    *)
      echo "::error::guard-lint-warnings.sh: ${CEILING_FILE} does not hold a single non-negative integer ceiling on its first non-comment line — refusing to run." >&2
      exit 1
      ;;
  esac
  ceiling="$parsed_value"
  ceiling_line="$parsed_line"
}

# --lower-to needs no oxlint: it only compares two numbers and rewrites one
# line, so release.yml can run it in the job that holds the push token
# without running the linter there.
if [ "$mode" = "lower" ]; then
  [[ "$lower_to" =~ ^[0-9]+$ ]] || usage "--lower-to takes a non-negative integer, got '${lower_to}'."
  load_ceiling
  target=$((10#$lower_to))
  if [ "$target" -eq "$ceiling" ]; then
    echo "guard-lint-warnings.sh: the ceiling in ${CEILING_FILE} is already ${ceiling}; file unchanged."
    exit 0
  fi
  if [ "$target" -gt "$ceiling" ]; then
    echo "::warning::guard-lint-warnings.sh: ${target} is above the ceiling of ${ceiling} in ${CEILING_FILE}. --lower-to never raises it, so the file is unchanged; the absolute check fails on this tree until a pull request removes the extra warnings or raises the ceiling on purpose." >&2
    exit 0
  fi
  # Only the value line changes; every comment line is kept byte for byte.
  # Written through a temporary file and copied back, which keeps the
  # file's mode.
  new_line="${target}   # lowered by scripts/guard-lint-warnings.sh --lower-to, $(date -u +%Y-%m-%d)"
  rewritten="$(mktemp)"
  awk -v target_line="$ceiling_line" -v replacement="$new_line" \
    'NR == target_line { print replacement; next } { print }' "$CEILING_FILE" >"$rewritten"
  cat "$rewritten" >"$CEILING_FILE"
  rm -f "$rewritten"
  echo "guard-lint-warnings.sh: lowered the ceiling in ${CEILING_FILE} from ${ceiling} to ${target}."
  exit 0
fi

if [ "$mode" != "count" ]; then
  load_ceiling
fi

# Everything --base needs is checked before anything is measured, so a bad
# revision or path fails in a second rather than after a lint run.
if [ "$mode" = "base" ]; then
  case "$CEILING_FILE" in
    "$LINT_ROOT"/*) ceiling_rel="${CEILING_FILE#"$LINT_ROOT"/}" ;;
    *)
      echo "::error::guard-lint-warnings.sh: --base reads the base's own copy of the ceiling file at the same path, so ${CEILING_FILE} must be inside ${LINT_ROOT}." >&2
      exit 1
      ;;
  esac
  if ! base_commit="$(git -C "$LINT_ROOT" rev-parse --verify --quiet "${base_rev}^{commit}")"; then
    echo "::error::guard-lint-warnings.sh: --base ${base_rev} is not a commit in ${LINT_ROOT}. In CI the checkout needs fetch-depth: 2 for HEAD^1 to exist." >&2
    exit 1
  fi
  repo_top="$(git -C "$LINT_ROOT" rev-parse --show-toplevel)"
  root_prefix="$(git -C "$LINT_ROOT" rev-parse --show-prefix)"
fi

if [ ! -x "$OXLINT_BIN" ]; then
  echo "::error::guard-lint-warnings.sh: oxlint binary not found or not executable at ${OXLINT_BIN} — run \`bun install\` first." >&2
  exit 1
fi

WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

# Runs oxlint the way `bun run lint` does (oxlint -c oxlintrc.json .), plus
# --format=json, from <dir> so relative paths in the config and the "."
# target resolve exactly as they do for that script. Sets measured_count and
# writes the per-rule breakdown to <out>.rules. Returns 2 when oxlint exits
# non-zero (status in oxlint_status, stderr in <out>.stderr) and 1 when no
# count can be read from its report.
measure() {
  local dir="$1" bin="$2" out="$3"
  oxlint_status=0
  (cd "$dir" && "$bin" -c oxlintrc.json . --format=json) >"$out.json" 2>"$out.stderr" || oxlint_status=$?
  [ "$oxlint_status" -eq 0 ] || return 2
  bun "$SCRIPT_DIR/lint-warning-count.ts" "$out.json" >"$out.result" || return 1
  measured_count="$(head -n1 "$out.result")"
  [[ "$measured_count" =~ ^[0-9]+$ ]] || return 1
  tail -n +2 "$out.result" >"$out.rules"
}

status=0
measure "$LINT_ROOT" "$OXLINT_BIN" "$WORK_DIR/tree" || status=$?
case "$status" in
  0) count="$measured_count" ;;
  2)
    echo "::error::guard-lint-warnings.sh: oxlint exited with status ${oxlint_status} — an error-level rule fired, not just warnings. Run \`bun run lint\` to see it; this guard only checks the warning count and cannot make a meaningful comparison while lint itself is failing." >&2
    cat "$WORK_DIR/tree.stderr" >&2
    exit 1
    ;;
  *)
    echo "::error::guard-lint-warnings.sh: could not determine a warning count from oxlint's output." >&2
    exit 1
    ;;
esac

if [ "$mode" = "count" ]; then
  printf '%s\n' "$count"
  exit 0
fi

print_breakdown() {
  echo "Warnings by rule (highest first):" >&2
  sed 's/^/  /' "$WORK_DIR/tree.rules" >&2
  echo "Run \`bun run lint\` locally to see file:line locations for the rules above." >&2
}

raise_advice() {
  echo "If the new warnings are intentional, raise the ceiling: set it to $1 in ${CEILING_FILE} and put your branch and date in the line's trailing comment. Otherwise remove them." >&2
}

if [ "$mode" = "base" ]; then
  # The base's tree, written out through a temporary index.
  base_tree="$WORK_DIR/base"
  base_index="$WORK_DIR/base.index"
  mkdir -p "$base_tree"
  GIT_INDEX_FILE="$base_index" git -C "$repo_top" read-tree "$base_commit"
  GIT_INDEX_FILE="$base_index" git -C "$repo_top" checkout-index -a --prefix="$base_tree/"
  base_root="$base_tree/${root_prefix}"
  base_root="${base_root%/}"

  base_bin="$OXLINT_BIN"
  if [ -f "$base_root/package.json" ]; then
    if ! (cd "$base_root" && bun install --frozen-lockfile --ignore-scripts) >"$WORK_DIR/base-install.log" 2>&1; then
      echo "::error::guard-lint-warnings.sh: could not install the base ${base_rev}'s own dependencies to lint it with its own toolchain. bun install said:" >&2
      cat "$WORK_DIR/base-install.log" >&2
      exit 1
    fi
    base_bin="$base_root/node_modules/.bin/oxlint"
  fi

  status=0
  measure "$base_root" "$base_bin" "$WORK_DIR/base" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "::error::guard-lint-warnings.sh: could not lint the base ${base_rev} with its own toolchain (oxlint status ${oxlint_status}), so there is nothing to compare this tree with. oxlint said:" >&2
    cat "$WORK_DIR/base.stderr" >&2
    exit 1
  fi
  base_count="$measured_count"

  if ! parse_ceiling "$base_root/$ceiling_rel"; then
    echo "::error::guard-lint-warnings.sh: the base ${base_rev} has no readable ceiling at ${ceiling_rel}, so the raise this tree makes cannot be measured." >&2
    exit 1
  fi
  base_ceiling="$parsed_value"

  raise=$((ceiling > base_ceiling ? ceiling - base_ceiling : 0))
  allowed=$((base_count + raise))
  added=$((count - base_count))
  needed=$((base_ceiling + (added > 0 ? added : 0)))
  needed=$((needed > count ? needed : count))

  if [ "$count" -gt "$allowed" ]; then
    echo "::error::guard-lint-warnings.sh: this tree has ${count} lint warnings and the base has ${base_count} (${base_rev}), so this branch adds $(plural "$added"), more than the raise of ${raise} it makes to the ceiling in ${CEILING_FILE}." >&2
    # Each rule's line is "<rule> <count>"; the count is the last field, and
    # a rule name may hold a space ("(unknown rule)"). The base's file is told
    # apart by name, not by line number, so an empty one still works.
    echo "Rules that rose against the base:" >&2
    awk '{ n = $NF; $NF = ""; sub(/ $/, ""); if (FILENAME == ARGV[1]) { base[$0] = n; next } if (n - base[$0] > 0) printf "  %s +%d\n", $0, n - base[$0] }' \
      "$WORK_DIR/base.rules" "$WORK_DIR/tree.rules" >&2
    echo "Run \`bun run lint\` locally to see file:line locations for the rules above." >&2
    raise_advice "$needed"
    exit 1
  fi
  if [ "$count" -gt "$ceiling" ]; then
    echo "::error::guard-lint-warnings.sh: ${count} lint warnings exceeds the ceiling of ${ceiling} in ${CEILING_FILE} by $((count - ceiling)), though the base has ${base_count} (${base_rev}) and this branch adds none beyond its raise. Fix the base first, or set the ceiling to what this tree holds." >&2
    print_breakdown
    raise_advice "$needed"
    exit 1
  fi
  echo "guard-lint-warnings.sh: this tree has ${count} lint warnings and the base has ${base_count} (${base_rev}); this branch adds none beyond the raise of ${raise} it makes."
fi

if [ "$count" -gt "$ceiling" ]; then
  echo "::error::guard-lint-warnings.sh: ${count} lint warnings exceeds the ceiling of ${ceiling} in ${CEILING_FILE} by $((count - ceiling)). This tree added at least one new warning." >&2
  print_breakdown
  raise_advice "$count"
  exit 1
fi

if [ "$count" -eq "$ceiling" ]; then
  echo "guard-lint-warnings.sh: ${count} lint warnings, matches the ceiling in ${CEILING_FILE}."
  exit 0
fi

echo "::notice::guard-lint-warnings.sh: ${count} lint warnings is below the ceiling of ${ceiling} in ${CEILING_FILE} by $((ceiling - count)). Leave the file alone: release.yml lowers it on main after the merge."
exit 0
