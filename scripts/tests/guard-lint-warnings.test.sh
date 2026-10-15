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
# purpose (see that job's own comment in ci.yml). The `--base` cases also
# need `git`, and one of them runs `bun install` in a fixture.
#
# Covers, one case per independent decision point — including the
# directions wiki/conventions/bundle-size-guards.md's corollary requires
# ("you have not verified a guard until you have seen it fail"):
#
#   no argument (the absolute check)
#     count == ceiling -> exit 0
#     count >  ceiling -> exit 1, reports the delta and a rule breakdown
#     count <  ceiling -> exit 0, says to leave the file alone, file unchanged
#     ceiling file missing or unparseable, oxlint missing, an error-level
#     rule firing, an unknown argument -> exit 1, each with its own message
#   --count     prints the count alone; prints nothing and fails on any error
#   --lower-to  lowers the value line only; never raises; refuses bad input
#   --base      holds a tree to its base commit: the two-branch merge in
#               either order, an added warning, a raise and its edges, the
#               lagging-ceiling case the absolute check alone lets through,
#               the first parent of a real merge, a rule turned on, a base
#               over its own ceiling, a nested root, a base installed from its
#               own lockfile and linted with its own oxlint, and each way the
#               base cannot be measured
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

# Fixture repositories must not pick up the developer's own git config:
# commit signing, hooks or a default branch name would change what they do.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

# A fixture project with its own oxlintrc.json and exactly $2 warning-level
# `no-console` diagnostics (one console.log per line), so the total is known
# without depending on this repo's own rule set or file tree.
make_fixture_project() {
  local root="$1" n="$2" i
  mkdir -p "$root"
  cat >"$root/oxlintrc.json" <<'EOF'
{
  "categories": { "correctness": "error" },
  "rules": { "no-console": "warn" },
  "ignorePatterns": ["node_modules"]
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
  shift 2
  LINT_WARNING_CEILING_FILE="$ceiling_file" \
    LINT_WARNING_ROOT="$fixture_root" \
    LINT_WARNING_OXLINT_BIN="$oxlint_bin" \
    bash "$guard" "$@"
}

assert() {
  local name="$1" got_exit="$2" want_exit="$3" output="$4" want_substr="$5"
  if [ "$got_exit" -ne "$want_exit" ]; then
    echo "FAIL - $name (exit $got_exit, want $want_exit)"
    echo "  output: $output"
    fail=$((fail + 1))
    return
  fi
  if [ -n "$want_substr" ] && ! printf '%s' "$output" | grep -qF -- "$want_substr"; then
    echo "FAIL - $name (missing '$want_substr' in output)"
    echo "  output: $output"
    fail=$((fail + 1))
    return
  fi
  echo "ok   - $name"
  pass=$((pass + 1))
}

assert_contains() {
  local name="$1" output="$2" want_substr="$3"
  if printf '%s' "$output" | grep -qF -- "$want_substr"; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (missing '$want_substr')"
    echo "  output: $output"
    fail=$((fail + 1))
  fi
}

assert_lacks() {
  local name="$1" output="$2" unwanted="$3"
  if printf '%s' "$output" | grep -qF -- "$unwanted"; then
    echo "FAIL - $name (unexpected '$unwanted')"
    echo "  output: $output"
    fail=$((fail + 1))
  else
    echo "ok   - $name"
    pass=$((pass + 1))
  fi
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (got '$got', want '$want')"
    fail=$((fail + 1))
  fi
}

assert_same_file() {
  local name="$1" got="$2" want="$3"
  if cmp -s "$got" "$want"; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (file changed)"
    diff "$want" "$got" | sed 's/^/  /'
    fail=$((fail + 1))
  fi
}

# The number on a ceiling file's value line: the first non-blank,
# non-comment line, as the guard reads it.
ceiling_value() {
  sed -e 's/#.*//' -e 's/[[:space:]]//g' "$1" | grep -m1 -v '^$'
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- No argument: the absolute check -------------------------------------

# Equal -> pass.
fx1="$tmp/eq"
make_fixture_project "$fx1" 3
ceiling1="$tmp/ceiling-eq.txt"
printf '3\n' >"$ceiling1"
out="$(run_guard "$ceiling1" "$fx1" 2>&1)"
assert "count equal to the ceiling exits 0" "$?" 0 "$out" "matches the ceiling"

# Over -> fail, reports delta and rule breakdown.
fx2="$tmp/over"
make_fixture_project "$fx2" 3
ceiling2="$tmp/ceiling-over.txt"
printf '1\n' >"$ceiling2"
out="$(run_guard "$ceiling2" "$fx2" 2>&1)"
got=$?
assert "count over the ceiling exits non-zero, reports the delta" "$got" 1 "$out" "exceeds the ceiling of 1"
assert_contains "over-ceiling message names the delta (2)" "$out" "by 2"
assert_contains "over-ceiling message breaks warnings down by rule" "$out" "eslint(no-console) 3"
assert_contains "over-ceiling message names the value a deliberate raise sets" "$out" "set it to 3"

# Under -> pass, leaves the file alone, says who lowers it.
fx3="$tmp/under"
make_fixture_project "$fx3" 3
ceiling3="$tmp/ceiling-under.txt"
printf '# a comment\n10   # measured on a branch\n' >"$ceiling3"
cp "$ceiling3" "$tmp/ceiling-under.orig"
out="$(run_guard "$ceiling3" "$fx3" 2>&1)"
assert "count under the ceiling exits 0" "$?" 0 "$out" "below the ceiling of 10"
assert_contains "under-ceiling message says to leave the file alone" "$out" "Leave the file alone"
assert_contains "under-ceiling message names what lowers it" "$out" "release.yml"
assert_same_file "under-ceiling run leaves the ceiling file unchanged" "$ceiling3" "$tmp/ceiling-under.orig"

# Ceiling file missing -> refuses to run.
fx4="$tmp/missing-ceiling-fixture"
make_fixture_project "$fx4" 3
out="$(run_guard "$tmp/does-not-exist.txt" "$fx4" 2>&1)"
assert "a missing ceiling file refuses to run" "$?" 1 "$out" "ceiling file not found"

# Ceiling file unparseable -> refuses to run.
fx5="$tmp/bad-ceiling-fixture"
make_fixture_project "$fx5" 3
ceiling5="$tmp/ceiling-bad.txt"
printf 'not-a-number\n' >"$ceiling5"
out="$(run_guard "$ceiling5" "$fx5" 2>&1)"
assert "an unparseable ceiling file refuses to run" "$?" 1 "$out" "does not hold a single non-negative integer"

# Blank lines and a comment before the number are ignored.
fx6="$tmp/comment-ceiling-fixture"
make_fixture_project "$fx6" 3
ceiling6="$tmp/ceiling-comment.txt"
printf '\n# a full-line comment\n3   # measured on 2026-09-11\n' >"$ceiling6"
out="$(run_guard "$ceiling6" "$fx6" 2>&1)"
assert "blank lines and a leading comment line are ignored" "$?" 0 "$out" "matches the ceiling"

# The oxlint binary itself missing -> refuses to run.
fx7="$tmp/no-oxlint-fixture"
make_fixture_project "$fx7" 3
ceiling7="$tmp/ceiling-no-oxlint.txt"
printf '3\n' >"$ceiling7"
out="$(LINT_WARNING_CEILING_FILE="$ceiling7" LINT_WARNING_ROOT="$fx7" LINT_WARNING_OXLINT_BIN="$tmp/no-such-oxlint" bash "$guard" 2>&1)"
assert "a missing oxlint binary refuses to run" "$?" 1 "$out" "oxlint binary not found"

# An error-level rule firing fails differently from a count mismatch —
# this guard cannot make a meaningful comparison while lint itself is
# failing, so it must not report a delta at all.
fx8="$tmp/error-fixture"
make_fixture_project_with_error "$fx8" 3
ceiling8="$tmp/ceiling-error.txt"
printf '3\n' >"$ceiling8"
out="$(run_guard "$ceiling8" "$fx8" 2>&1)"
got=$?
assert "an error-level rule firing exits non-zero with a distinct message" "$got" 1 "$out" "an error-level rule fired"
assert_lacks "the oxlint-error case does not also claim a count mismatch" "$out" "exceeds the ceiling"

# An unknown argument refuses to run.
out="$(run_guard "$ceiling1" "$fx1" --frobnicate 2>&1)"
assert "an unknown argument refuses to run" "$?" 1 "$out" "unknown argument"

# An argument after the mode refuses to run.
out="$(run_guard "$ceiling1" "$fx1" --count extra 2>&1)"
assert "an extra argument refuses to run" "$?" 1 "$out" "unexpected argument"

# oxlint exiting 0 with output that is not a report: no count, no pass.
fake_oxlint="$tmp/fake-oxlint"
printf '#!/usr/bin/env bash\necho "not a report"\n' >"$fake_oxlint"
chmod +x "$fake_oxlint"
out="$(LINT_WARNING_CEILING_FILE="$ceiling1" LINT_WARNING_ROOT="$fx1" LINT_WARNING_OXLINT_BIN="$fake_oxlint" bash "$guard" 2>&1)"
assert "an unreadable oxlint report refuses to run" "$?" 1 "$out" "could not determine a warning count"
out="$(LINT_WARNING_CEILING_FILE="$ceiling1" LINT_WARNING_ROOT="$fx1" LINT_WARNING_OXLINT_BIN="$fake_oxlint" bash "$guard" --count 2>/dev/null)"
assert "--count fails on an unreadable oxlint report" "$?" 1 "$out" ""
assert_eq "--count prints nothing on stdout for an unreadable report" "$out" ""

# --- --count ---------------------------------------------------------------

out="$(run_guard "$tmp/no-ceiling-needed.txt" "$fx1" --count 2>/dev/null)"
assert "--count exits 0 with no ceiling file" "$?" 0 "$out" ""
assert_eq "--count prints the count alone on stdout" "$out" "3"

out="$(run_guard "$ceiling8" "$fx8" --count 2>/dev/null)"
assert "--count fails when an error-level rule fires" "$?" 1 "$out" ""
assert_eq "--count prints nothing on stdout when lint fails" "$out" ""

out="$(LINT_WARNING_CEILING_FILE="$ceiling7" LINT_WARNING_ROOT="$fx7" LINT_WARNING_OXLINT_BIN="$tmp/no-such-oxlint" bash "$guard" --count 2>/dev/null)"
assert "--count fails when the oxlint binary is missing" "$?" 1 "$out" ""
assert_eq "--count prints nothing on stdout when oxlint is missing" "$out" ""

# --- --lower-to ------------------------------------------------------------

# Below: only the value line changes; every other line is kept byte for byte.
lower_file="$tmp/ceiling-lower.txt"
printf '# Ceiling comment block.\n#\n# More words.\n\n10   # measured on feat/x @ 2026-10-01\n# trailing comment line\n' >"$lower_file"
out="$(run_guard "$lower_file" "$fx1" --lower-to 3 2>&1)"
assert "--lower-to below the ceiling exits 0" "$?" 0 "$out" "lowered"
assert_eq "--lower-to writes the new value" "$(ceiling_value "$lower_file")" "3"
assert_eq "--lower-to keeps the lines before the value line" "$(sed -n 1,4p "$lower_file")" "$(printf '# Ceiling comment block.\n#\n# More words.\n')"
assert_eq "--lower-to keeps the lines after the value line" "$(sed -n 6p "$lower_file")" "# trailing comment line"
assert_eq "--lower-to keeps the line count" "$(wc -l <"$lower_file" | tr -d ' ')" "6"
assert_contains "--lower-to names itself on the value line" "$(sed -n 5p "$lower_file")" "--lower-to"
out="$(run_guard "$lower_file" "$fx1" 2>&1)"
assert "after --lower-to the guard matches" "$?" 0 "$out" "matches the ceiling"

# Equal: the file is not touched, so a re-run never makes an empty commit.
cp "$lower_file" "$tmp/ceiling-lower.before"
out="$(run_guard "$lower_file" "$fx1" --lower-to 3 2>&1)"
assert "--lower-to at the ceiling exits 0" "$?" 0 "$out" ""
assert_same_file "--lower-to at the ceiling leaves the file unchanged" "$lower_file" "$tmp/ceiling-lower.before"

# Above: never raises.
out="$(run_guard "$lower_file" "$fx1" --lower-to 7 2>&1)"
assert "--lower-to above the ceiling exits 0" "$?" 0 "$out" "never raises"
assert_same_file "--lower-to above the ceiling leaves the file unchanged" "$lower_file" "$tmp/ceiling-lower.before"

# The count reaches --lower-to from another job. A number too long to be a
# warning count (one that would wrap in shell arithmetic) is refused, and a
# value that is not a number is refused without being echoed back.
out="$(run_guard "$lower_file" "$fx1" --lower-to 18446744073709551615 2>&1)"
assert "--lower-to refuses a number of more than nine digits" "$?" 1 "$out" "at most nine digits"
assert_same_file "--lower-to on a too-long number leaves the file unchanged" "$lower_file" "$tmp/ceiling-lower.before"
out="$(run_guard "$lower_file" "$fx1" --lower-to "$(printf '3\n::error::forged')" 2>&1)"
assert "--lower-to refuses a value with a line break" "$?" 1 "$out" "non-negative integer"
assert_lacks "--lower-to does not echo a refused value" "$out" "forged"
long_ceiling="$tmp/ceiling-long.txt"
printf '1234567890\n' >"$long_ceiling"
out="$(run_guard "$long_ceiling" "$fx1" 2>&1)"
assert "a ceiling of more than nine digits refuses to run" "$?" 1 "$out" "does not hold a single non-negative integer"

# Bad input.
out="$(run_guard "$lower_file" "$fx1" --lower-to abc 2>&1)"
assert "--lower-to with a non-integer refuses" "$?" 1 "$out" "non-negative integer"
out="$(run_guard "$lower_file" "$fx1" --lower-to 2>&1)"
assert "--lower-to with no value refuses" "$?" 1 "$out" "--lower-to needs"
out="$(run_guard "$tmp/does-not-exist.txt" "$fx1" --lower-to 3 2>&1)"
assert "--lower-to with no ceiling file refuses" "$?" 1 "$out" "ceiling file not found"
out="$(run_guard "$ceiling5" "$fx1" --lower-to 3 2>&1)"
assert "--lower-to with an unparseable ceiling file refuses" "$?" 1 "$out" "does not hold a single non-negative integer"
assert_same_file "--lower-to on bad input leaves the file unchanged" "$lower_file" "$tmp/ceiling-lower.before"

# Value-line edge cases, run with no oxlint at all: --lower-to never lints.
lower_only() {
  LINT_WARNING_CEILING_FILE="$1" LINT_WARNING_ROOT="$fx1" LINT_WARNING_OXLINT_BIN="$tmp/no-such-oxlint" \
    bash "$guard" --lower-to "$2"
}
edge="$tmp/ceiling-edge.txt"
printf '08\n' >"$edge"
out="$(lower_only "$edge" 3 2>&1)"
assert "--lower-to reads a leading zero as decimal and needs no oxlint" "$?" 0 "$out" "from 8 to 3"
printf '5' >"$edge"
out="$(lower_only "$edge" 2 2>&1)"
assert "--lower-to handles a value line with no trailing newline" "$?" 0 "$out" "from 5 to 2"
assert_eq "--lower-to writes the value when the file had no trailing newline" "$(ceiling_value "$edge")" "2"
printf '# only\n# comments\n' >"$edge"
out="$(lower_only "$edge" 2 2>&1)"
assert "--lower-to refuses a file of comments only" "$?" 1 "$out" "does not hold a single non-negative integer"
printf '3 4\n' >"$edge"
out="$(lower_only "$edge" 2 2>&1)"
assert "--lower-to refuses two numbers on the value line" "$?" 1 "$out" "does not hold a single non-negative integer"
printf '# c\n9   # note\n' >"$edge"
chmod 640 "$edge"
mode_before="$(ls -l "$edge" | cut -c1-10)"
lower_only "$edge" 4 >/dev/null 2>&1
assert_eq "--lower-to keeps the file's mode" "$(ls -l "$edge" | cut -c1-10)" "$mode_before"

# --- --base: the check pull-request CI runs --------------------------------

g() { git -C "$repo" -c user.name=guard-test -c user.email=guard-test@example.invalid -c commit.gpgsign=false "$@"; }

# $1 = file under src/, $2 = how many console.log lines it holds.
put_warnings() {
  local file="$repo/src/$1" n="$2" i
  : >"$file"
  for ((i = 0; i < n; i++)); do
    echo "console.log(${i});" >>"$file"
  done
  [ "$n" -eq 0 ] && echo "export {};" >"$file"
  return 0
}

set_ceiling() {
  printf '# fixture ceiling\n%s   # %s\n' "$1" "$2" >"$repo/ceiling.txt"
}

commit_all() {
  g add -A && g commit -qm "$1"
}

run_base() {
  LINT_WARNING_CEILING_FILE="$repo/ceiling.txt" \
    LINT_WARNING_ROOT="$repo" \
    LINT_WARNING_OXLINT_BIN="$oxlint_bin" \
    bash "$guard" "$@"
}

# main: three files, one warning each, ceiling 3.
repo="$tmp/base-repo"
make_fixture_project "$repo" 0
rm "$repo/src/a.ts"
git -c init.defaultBranch=main init -q "$repo"
put_warnings one.ts 1
put_warnings two.ts 1
put_warnings three.ts 1
set_ceiling 3 "fixture start"
commit_all "start"
g tag start

# Two branches that each remove one warning, ceiling untouched.
g checkout -q -b remove-one start
put_warnings one.ts 0
commit_all "remove one"
out="$(run_base --base main 2>&1)"
assert "--base: a branch that removes a warning passes with the ceiling untouched" "$?" 0 "$out" "below the ceiling of 3"

g checkout -q -b remove-two start
put_warnings two.ts 0
commit_all "remove two"
out="$(run_base --base main 2>&1)"
assert "--base: a second branch that removes a different warning passes too" "$?" 0 "$out" "below the ceiling of 3"

# A branch that adds one fails, and passes once it raises the ceiling.
g checkout -q -b add-four start
put_warnings four.ts 1
commit_all "add four"
out="$(run_base --base main 2>&1)"
got=$?
assert "--base: a branch that adds a warning fails" "$got" 1 "$out" "adds 1 warning"
assert_contains "--base: the failure names the ceiling a deliberate raise sets" "$out" "set it to 4"
assert_contains "--base: the failure names the rule that rose against the base" "$out" "eslint(no-console) +1"
set_ceiling 4 "add-four @ fixture"
commit_all "raise for four"
out="$(run_base --base main 2>&1)"
assert "--base: the same branch passes once it raises the ceiling" "$?" 0 "$out" ""

# Merge the two removals in either order. The second to land is checked the
# way CI checks it: the merge commit against its first parent, which already
# holds the first removal while the ceiling still says 3.
g checkout -q main
g merge -q --no-edit remove-one >/dev/null 2>&1
after_one="$(g rev-parse HEAD)"
g merge -q --no-edit remove-two >/dev/null 2>&1
out="$(run_base --base HEAD^1 2>&1)"
assert "--base: the second removal to land passes against a base that holds the first" "$?" 0 "$out" "below the ceiling of 3"
g checkout -q -b other-order start
g merge -q --no-edit remove-two >/dev/null 2>&1
g merge -q --no-edit remove-one >/dev/null 2>&1
out="$(run_base --base HEAD^1 2>&1)"
assert "--base: the same holds with the removals landing in the other order" "$?" 0 "$out" "below the ceiling of 3"
g checkout -q main
merged_count="$(run_base --count 2>/dev/null)"
assert_eq "--base: the merged tree holds one warning" "$merged_count" "1"
out="$(run_base --lower-to "$merged_count" 2>&1)"
assert "--base: lowering the merged ceiling succeeds" "$?" 0 "$out" "lowered"
out="$(run_base 2>&1)"
assert "--base: after lowering, the ceiling equals the measured count" "$?" 0 "$out" "matches the ceiling"
g checkout -q -- ceiling.txt

# The lagging ceiling: main holds 2 warnings after the first removal but its
# ceiling still says 3. A branch that adds one passes the absolute check
# alone (3 <= 3) and must still fail against its base.
g checkout -q -b lagging "$after_one"
put_warnings four.ts 1
commit_all "add four after one was removed"
out="$(run_base 2>&1)"
assert "--base: the absolute check alone lets the lagging-ceiling case through" "$?" 0 "$out" "matches the ceiling"
out="$(run_base --base "$after_one" 2>&1)"
assert "--base: the base check fails the lagging-ceiling case" "$?" 1 "$out" "adds 1 warning"

# A deliberate raise while the ceiling lags: base has 1 warning under a
# ceiling of 3, the branch adds 2. One message, one number: 3 + 2 = 5.
g checkout -q -b lag-raise main
put_warnings four.ts 2
commit_all "add two while the ceiling lags"
out="$(run_base --base main 2>&1)"
got=$?
assert "--base: adding 2 under a lagging ceiling fails" "$got" 1 "$out" "adds 2 warnings"
assert_contains "--base: it names the one ceiling that passes" "$out" "set it to 5"
set_ceiling 5 "lag-raise @ fixture"
commit_all "raise to 5"
out="$(run_base --base main 2>&1)"
assert "--base: setting the named ceiling passes" "$?" 0 "$out" ""

# The first parent of a real merge commit is the base. main (first parent)
# holds 2; an old branch (second parent) holds 4; the merge holds 3.
g checkout -q -b old-side start
put_warnings five.ts 1
commit_all "old side adds five"
g checkout -q -b merge-check "$after_one"
g merge -q --no-ff --no-edit old-side >/dev/null 2>&1
out="$(run_base --base HEAD^2 2>&1)"
assert "--base HEAD^2: the second parent would let the merge through" "$?" 0 "$out" ""
out="$(run_base --base HEAD^1 2>&1)"
assert "--base HEAD^1: compared with the first parent the merge adds one" "$?" 1 "$out" "adds 1 warning"

# Each way the base cannot be measured fails with its own message.
out="$(run_base --base no-such-ref 2>&1)"
assert "--base: an unknown revision refuses" "$?" 1 "$out" "is not a commit"
out="$(run_base --base 2>&1)"
assert "--base: no revision refuses" "$?" 1 "$out" "--base needs"

g checkout -q -b no-ceiling start
g rm -q ceiling.txt
commit_all "drop the ceiling file"
no_ceiling_rev="$(g rev-parse HEAD)"
g checkout -q main
out="$(run_base --base "$no_ceiling_rev" 2>&1)"
assert "--base: a base with no ceiling file refuses" "$?" 1 "$out" "no readable ceiling"

g checkout -q -b broken-base start
make_fixture_project_with_error "$tmp/broken-src" 0
cp "$tmp/broken-src/oxlintrc.json" "$repo/oxlintrc.json"
echo "debugger;" >"$repo/src/debug.ts"
commit_all "base with an error-level rule"
broken_rev="$(g rev-parse HEAD)"
g checkout -q main
out="$(run_base --base "$broken_rev" 2>&1)"
assert "--base: a base whose lint run fails refuses with its own message" "$?" 1 "$out" "could not lint the base"

out="$(LINT_WARNING_CEILING_FILE="$ceiling1" LINT_WARNING_ROOT="$repo" LINT_WARNING_OXLINT_BIN="$oxlint_bin" bash "$guard" --base start 2>&1)"
assert "--base: a ceiling file outside the linted root refuses" "$?" 1 "$out" "inside"

# Raise arithmetic at its edges. From the start (3 warnings, ceiling 3): a
# branch that adds 2 but raises by 1 still fails and names the full number;
# a branch that removes one and lowers the ceiling to match passes.
g checkout -q -b short-raise start
put_warnings four.ts 2
set_ceiling 4 "short-raise @ fixture"
commit_all "add two, raise by one"
out="$(run_base --base start 2>&1)"
got=$?
assert "--base: a raise one short of what the branch adds fails" "$got" 1 "$out" "adds 2 warnings"
assert_contains "--base: it names the full raise" "$out" "set it to 5"
g checkout -q -b hand-lowered start
put_warnings one.ts 0
set_ceiling 2 "hand-lowered @ fixture"
commit_all "remove one and lower by hand"
out="$(run_base --base start 2>&1)"
assert "--base: a branch that lowers the ceiling to its own count passes" "$?" 0 "$out" "matches the ceiling"

# The rules that rose are listed even when the base has no warnings at all.
g checkout -q -b zero-base start
put_warnings one.ts 0
put_warnings two.ts 0
put_warnings three.ts 0
commit_all "no warnings"
g checkout -q -b zero-add zero-base
put_warnings four.ts 1
commit_all "add one to an empty base"
out="$(run_base --base zero-base 2>&1)"
got=$?
assert "--base: adding one to a base with none fails" "$got" 1 "$out" "adds 1 warning"
assert_contains "--base: the rule that rose is listed when the base has none" "$out" "eslint(no-console) +1"
g checkout -q main

# A fresh repository for the cases that need their own config or layout.
new_repo() {
  repo="$tmp/$1"
  git -c init.defaultBranch=main init -q "$repo"
  mkdir -p "$repo/src"
}

# The base is linted with its own oxlintrc.json: a branch that turns a rule
# from off to warn adds every warning that rule finds.
new_repo config-repo
printf '{ "categories": { "correctness": "error" }, "rules": { "no-console": "off" } }\n' >"$repo/oxlintrc.json"
put_warnings one.ts 3
set_ceiling 3 "config fixture"
commit_all "no-console off"
printf '{ "categories": { "correctness": "error" }, "rules": { "no-console": "warn" } }\n' >"$repo/oxlintrc.json"
commit_all "no-console warn"
out="$(run_base --base HEAD^1 2>&1)"
assert "--base: a branch that turns a rule on is measured against the base's own config" "$?" 1 "$out" "adds 3 warnings"

# Only the rules that rose are listed.
new_repo rules-repo
printf '{ "categories": { "correctness": "error" }, "rules": { "no-console": "warn", "no-debugger": "warn" } }\n' >"$repo/oxlintrc.json"
put_warnings one.ts 1
set_ceiling 1 "rules fixture"
commit_all "one console"
echo "debugger;" >"$repo/src/dbg.ts"
commit_all "add a debugger statement"
out="$(run_base --base HEAD^1 2>&1)"
got=$?
assert "--base: a branch that adds a different rule's warning fails" "$got" 1 "$out" "eslint(no-debugger) +1"
assert_lacks "--base: a rule that did not rise is not listed" "$out" "eslint(no-console)"

# A base already over its own ceiling: the branch adds nothing, so the
# failure points at the base and names a ceiling that passes.
new_repo red-base-repo
cp "$fx1/oxlintrc.json" "$repo/oxlintrc.json"
put_warnings one.ts 3
set_ceiling 2 "red base fixture"
commit_all "base over its ceiling"
echo "export const unrelated = 1;" >"$repo/src/unrelated.ts"
commit_all "an unrelated change"
out="$(run_base --base HEAD^1 2>&1)"
got=$?
assert "--base: a branch on a base over its ceiling fails on the ceiling" "$got" 1 "$out" "Fix the base first"
assert_contains "--base: it names a ceiling that passes, not the one that failed" "$out" "set it to 3"

# A base whose own dependencies cannot be installed fails with its own message.
new_repo bad-install-repo
cp "$fx1/oxlintrc.json" "$repo/oxlintrc.json"
printf '{ not json\n' >"$repo/package.json"
put_warnings one.ts 1
set_ceiling 1 "bad install fixture"
commit_all "a package.json bun cannot read"
rm "$repo/package.json"
commit_all "drop it"
out="$(run_base --base HEAD^1 2>&1)"
assert "--base: a base whose dependencies cannot be installed refuses" "$?" 1 "$out" "could not install the base"

# A linted root below the repository's top level.
new_repo nested-repo
mkdir -p "$repo/sub/src"
cp "$fx1/oxlintrc.json" "$repo/sub/oxlintrc.json"
echo "console.log(1);" >"$repo/sub/src/one.ts"
printf '1   # nested fixture\n' >"$repo/sub/ceiling.txt"
commit_all "nested start"
echo "console.log(2);" >"$repo/sub/src/two.ts"
commit_all "nested adds one"
out="$(LINT_WARNING_CEILING_FILE="$repo/sub/ceiling.txt" LINT_WARNING_ROOT="$repo/sub" LINT_WARNING_OXLINT_BIN="$oxlint_bin" bash "$guard" --base HEAD^1 2>&1)"
assert "--base: a linted root below the top level is compared with the same directory in the base" "$?" 1 "$out" "adds 1 warning"

# A base with its own package.json is installed and linted with its own
# oxlint, not this tree's: the wrapper below logs every call made through
# LINT_WARNING_OXLINT_BIN, and only the working tree may use it.
oxlint_version="$("$oxlint_bin" --version | sed 's/^Version: //')"
repo="$tmp/toolchain-repo"
git -c init.defaultBranch=main init -q "$repo"
mkdir -p "$repo/src"
cp "$fx1/oxlintrc.json" "$repo/oxlintrc.json"
printf '{\n  "name": "guard-fixture",\n  "private": true,\n  "devDependencies": { "oxlint": "%s" }\n}\n' "$oxlint_version" >"$repo/package.json"
printf 'node_modules\n' >"$repo/.gitignore"
put_warnings one.ts 2
set_ceiling 2 "toolchain fixture"
if (cd "$repo" && bun install >"$tmp/toolchain-install.log" 2>&1); then
  commit_all "toolchain start"
  wrapper="$tmp/logging-oxlint"
  calls="$tmp/oxlint-calls.log"
  : >"$calls"
  printf '#!/usr/bin/env bash\npwd >>"%s"\nexec "%s" "$@"\n' "$calls" "$oxlint_bin" >"$wrapper"
  chmod +x "$wrapper"
  out="$(LINT_WARNING_CEILING_FILE="$repo/ceiling.txt" LINT_WARNING_ROOT="$repo" LINT_WARNING_OXLINT_BIN="$wrapper" bash "$guard" --base HEAD 2>&1)"
  assert "--base: a base with its own package.json is measured" "$?" 0 "$out" "base has 2"
  assert_eq "--base: the base is linted with its own installed oxlint" "$(wc -l <"$calls" | tr -d ' ')" "1"

  # The base installs exactly what its lockfile pins. A base whose
  # package.json names a dependency its bun.lock does not hold refuses, where
  # a fresh resolution would quietly install it from the cache.
  plugins_version="$(sed -n 's/.*"@oxlint\/plugins": "\([^"]*\)".*/\1/p' "$repo_root/package.json")"
  printf '{\n  "name": "guard-fixture",\n  "private": true,\n  "devDependencies": { "oxlint": "%s", "@oxlint/plugins": "%s" }\n}\n' \
    "$oxlint_version" "$plugins_version" >"$repo/package.json"
  commit_all "a dependency the lockfile does not hold"
  echo "export const unrelated = 1;" >"$repo/src/unrelated.ts"
  commit_all "an unrelated change"
  out="$(run_base --base HEAD^1 2>&1)"
  assert "--base: a base whose lockfile is out of step with its package.json refuses" "$?" 1 "$out" "could not install the base"
else
  echo "FAIL - setup: bun install in the toolchain fixture failed"
  sed 's/^/  /' "$tmp/toolchain-install.log"
  fail=$((fail + 1))
fi

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
