#!/usr/bin/env bash
# Tests for guard-lint-warnings.sh. Plain-bash assertions (no bats
# dependency), matching the sibling shell tests under scripts/ (see
# verify-vendored-anti-slop.test.sh).
#
# Runs the REAL oxlint binary from this checkout's own node_modules
# (LINT_WARNING_OXLINT_BIN), against small throwaway fixture projects
# (LINT_WARNING_ROOT) with their own oxlintrc.json — never this repo's real
# tree, so these tests neither depend on nor perturb the real warning count.
# That is why this file needs a `bun install` to have already happened and
# therefore runs as its own step in ci.yml's `lint` job, after "Install
# dependencies" — not in the script-tests job, which does no install on
# purpose (see that job's own comment in ci.yml).
#
# Covers, one case per independent decision point — including the three
# directions wiki/conventions/bundle-size-guards.md's corollary requires
# ("you have not verified a guard until you have seen it fail"):
#
#   1. count == ceiling -> exit 0
#   2. count >  ceiling -> exit 1, reports the delta and a rule breakdown
#   3. count <  ceiling -> exit 1, says to lower the file, names the new count
#   4. ceiling file missing -> exit 1, refuses to run
#   5. ceiling file unparseable -> exit 1, refuses to run
#   6. blank lines and a comment before the number are ignored
#   7. the oxlint binary itself missing -> exit 1, refuses to run
#   8. an error-level rule firing -> exit 1, a DIFFERENT message than the
#      count-mismatch cases (this guard cannot compare a failed lint run)
#
# Run: bash scripts/tests/guard-lint-warnings.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
guard="$here/guard-lint-warnings.sh"
repo_root="$(cd "$here/.." && pwd)"
oxlint_bin="$repo_root/node_modules/.bin/oxlint"
pass=0
fail=0

if [ ! -x "$oxlint_bin" ]; then
  echo "FAIL - setup: no oxlint binary at $oxlint_bin — run \`bun install\` before this test." >&2
  exit 1
fi

# A fixture project with its own oxlintrc.json and exactly $2 warning-level
# `no-console` diagnostics (one console.log per line), so the total is known
# without depending on this repo's own rule set or file tree.
make_fixture_project() {
  local root="$1" n="$2" i
  mkdir -p "$root"
  cat >"$root/oxlintrc.json" <<'EOF'
{
  "categories": { "correctness": "error" },
  "rules": { "no-console": "warn" }
}
EOF
  mkdir -p "$root/src"
  : >"$root/src/a.ts"
  for ((i = 0; i < n; i++)); do
    echo "console.log(${i});" >>"$root/src/a.ts"
  done
}

# A fixture whose no-console warnings are STILL there (so a count-based
# assertion on it would look identical to the plain fixture) but which also
# trips an error-level rule — the case that must fail differently.
make_fixture_project_with_error() {
  local root="$1" n="$2"
  make_fixture_project "$root" "$n"
  cat >"$root/oxlintrc.json" <<'EOF'
{
  "categories": { "correctness": "error" },
  "rules": { "no-console": "warn", "no-debugger": "error" }
}
EOF
  echo "debugger;" >>"$root/src/a.ts"
}

run_guard() {
  local ceiling_file="$1" fixture_root="$2"
  LINT_WARNING_CEILING_FILE="$ceiling_file" \
    LINT_WARNING_ROOT="$fixture_root" \
    LINT_WARNING_OXLINT_BIN="$oxlint_bin" \
    bash "$guard"
}

assert() {
  local name="$1" got_exit="$2" want_exit="$3" output="$4" want_substr="$5"
  if [ "$got_exit" -ne "$want_exit" ]; then
    echo "FAIL - $name (exit $got_exit, want $want_exit)"
    echo "  output: $output"
    fail=$((fail + 1))
    return
  fi
  if [ -n "$want_substr" ] && ! printf '%s' "$output" | grep -qF "$want_substr"; then
    echo "FAIL - $name (missing '$want_substr' in output)"
    echo "  output: $output"
    fail=$((fail + 1))
    return
  fi
  echo "ok   - $name"
  pass=$((pass + 1))
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# 1. Equal -> pass.
fx1="$tmp/eq"
make_fixture_project "$fx1" 3
ceiling1="$tmp/ceiling-eq.txt"
printf '3\n' >"$ceiling1"
out="$(run_guard "$ceiling1" "$fx1" 2>&1)"
assert "count equal to the ceiling exits 0" "$?" 0 "$out" "matches the ceiling"

# 2. Over -> fail, reports delta and rule breakdown.
fx2="$tmp/over"
make_fixture_project "$fx2" 3
ceiling2="$tmp/ceiling-over.txt"
printf '1\n' >"$ceiling2"
out="$(run_guard "$ceiling2" "$fx2" 2>&1)"
got=$?
assert "count over the ceiling exits non-zero, reports the delta" "$got" 1 "$out" "exceeds the ceiling of 1"
if ! printf '%s' "$out" | grep -qF "by 2"; then
  echo "FAIL - over-ceiling message names the delta (2)"
  echo "  output: $out"
  fail=$((fail + 1))
else
  echo "ok   - over-ceiling message names the delta (2)"
  pass=$((pass + 1))
fi
if ! printf '%s' "$out" | grep -qF "eslint(no-console) 3"; then
  echo "FAIL - over-ceiling message breaks warnings down by rule"
  echo "  output: $out"
  fail=$((fail + 1))
else
  echo "ok   - over-ceiling message breaks warnings down by rule"
  pass=$((pass + 1))
fi

# 3. Under -> fail, says to lower the file, names the new count.
fx3="$tmp/under"
make_fixture_project "$fx3" 3
ceiling3="$tmp/ceiling-under.txt"
printf '10\n' >"$ceiling3"
out="$(run_guard "$ceiling3" "$fx3" 2>&1)"
got=$?
assert "count under the ceiling exits non-zero, says to lower the file" "$got" 1 "$out" "is below the ceiling of 10"
if ! printf '%s' "$out" | grep -qF "set it to 3"; then
  echo "FAIL - under-ceiling message names the new count (3)"
  echo "  output: $out"
  fail=$((fail + 1))
else
  echo "ok   - under-ceiling message names the new count (3)"
  pass=$((pass + 1))
fi

# 4. Ceiling file missing -> refuses to run.
fx4="$tmp/missing-ceiling-fixture"
make_fixture_project "$fx4" 3
out="$(run_guard "$tmp/does-not-exist.txt" "$fx4" 2>&1)"
assert "a missing ceiling file refuses to run" "$?" 1 "$out" "ceiling file not found"

# 5. Ceiling file unparseable -> refuses to run.
fx5="$tmp/bad-ceiling-fixture"
make_fixture_project "$fx5" 3
ceiling5="$tmp/ceiling-bad.txt"
printf 'not-a-number\n' >"$ceiling5"
out="$(run_guard "$ceiling5" "$fx5" 2>&1)"
assert "an unparseable ceiling file refuses to run" "$?" 1 "$out" "does not hold a single non-negative integer"

# 6. Blank lines and a comment before the number are ignored.
fx6="$tmp/comment-ceiling-fixture"
make_fixture_project "$fx6" 3
ceiling6="$tmp/ceiling-comment.txt"
printf '\n# a full-line comment\n3   # measured on 2026-09-11\n' >"$ceiling6"
out="$(run_guard "$ceiling6" "$fx6" 2>&1)"
assert "blank lines and a leading comment line are ignored" "$?" 0 "$out" "matches the ceiling"

# 7. The oxlint binary itself missing -> refuses to run.
fx7="$tmp/no-oxlint-fixture"
make_fixture_project "$fx7" 3
ceiling7="$tmp/ceiling-no-oxlint.txt"
printf '3\n' >"$ceiling7"
out="$(LINT_WARNING_CEILING_FILE="$ceiling7" LINT_WARNING_ROOT="$fx7" LINT_WARNING_OXLINT_BIN="$tmp/no-such-oxlint" bash "$guard" 2>&1)"
assert "a missing oxlint binary refuses to run" "$?" 1 "$out" "oxlint binary not found"

# 8. An error-level rule firing fails differently from a count mismatch —
# this guard cannot make a meaningful comparison while lint itself is
# failing, so it must not report a delta at all.
fx8="$tmp/error-fixture"
make_fixture_project_with_error "$fx8" 3
ceiling8="$tmp/ceiling-error.txt"
printf '3\n' >"$ceiling8"
out="$(run_guard "$ceiling8" "$fx8" 2>&1)"
got=$?
assert "an error-level rule firing exits non-zero with a distinct message" "$got" 1 "$out" "an error-level rule fired"
if printf '%s' "$out" | grep -qF "exceeds the ceiling"; then
  echo "FAIL - the oxlint-error case must not also claim a count mismatch"
  echo "  output: $out"
  fail=$((fail + 1))
else
  echo "ok   - the oxlint-error case does not also claim a count mismatch"
  pass=$((pass + 1))
fi

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
