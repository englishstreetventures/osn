#!/usr/bin/env bash
# Tests for verify-vendored-anti-slop.sh. Plain-bash assertions (no bats
# dependency), matching the sibling shell tests under scripts/.
#
# The guard has no injection point — it hardcodes `scripts/..` and
# `tools/oxlint/anti-slop` — so each case builds a throwaway git repo with that
# same shape, copies the real script in, and runs it there. That also means the
# cases never touch the repo's own vendored tree.
#
# Run: bash scripts/verify-vendored-anti-slop.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/verify-vendored-anti-slop.sh"
pass=0
fail=0

# A repo whose vendored tree matches its SHA256SUMS exactly.
make_fixture() {
  local root="$1"
  mkdir -p "$root/scripts" "$root/tools/oxlint/anti-slop/rules"
  cp "$guard" "$root/scripts/verify-vendored-anti-slop.sh"
  printf 'export const plugin = {};\n' > "$root/tools/oxlint/anti-slop/index.ts"
  printf 'MIT\n' > "$root/tools/oxlint/anti-slop/LICENSE"
  printf 'export const rule = {};\n' > "$root/tools/oxlint/anti-slop/rules/no-any.ts"
  (cd "$root/tools/oxlint/anti-slop" \
    && shasum -a 256 index.ts LICENSE rules/no-any.ts > SHA256SUMS)
  git -C "$root" init -q
  git -C "$root" add -A
  git -C "$root" -c user.email=t@t -c user.name=t commit -qm init
}

# $3 is the expected exit status; $4, when "gitdir", exports GIT_DIR the way git
# does for every hook it runs — the state that broke the cwd-relative listing.
run_case() {
  local name="$1" root="$2" want="$3" mode="${4:-clean}" got
  if [ "$mode" = "gitdir" ]; then
    GIT_DIR="$root/.git" bash "$root/scripts/verify-vendored-anti-slop.sh" >/dev/null 2>&1
  else
    bash "$root/scripts/verify-vendored-anti-slop.sh" >/dev/null 2>&1
  fi
  got=$?
  if [ "$got" -eq "$want" ]; then
    echo "ok   - $name (exit $got)"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (got exit $got, want $want)"
    fail=$((fail + 1))
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Baseline: an untouched vendored tree passes.
c="$tmp/clean"
make_fixture "$c"
run_case "matching tree passes" "$c" 0

# The regression. Git exports GIT_DIR to hooks, and with it set the guard used
# to list every tracked file in the repo rather than the vendored subtree, so
# the diff failed and lefthook blocked every commit staging a .js/.ts file.
run_case "matching tree passes with GIT_DIR set" "$c" 0 gitdir

# An edit to a vendored file is what the checksums exist to catch.
m="$tmp/modified"
make_fixture "$m"
printf 'export const plugin = { tampered: true };\n' > "$m/tools/oxlint/anti-slop/index.ts"
run_case "modified vendored file fails" "$m" 1

# ...and it must still be caught under GIT_DIR, so the fix above does not
# trade a false failure for a false pass.
run_case "modified vendored file fails with GIT_DIR set" "$m" 1 gitdir

# A file added to the tree is absent from SHA256SUMS, so `shasum -c` has
# nothing to check it against. Only the file-set diff catches this half.
a="$tmp/added"
make_fixture "$a"
printf 'export const rule = {};\n' > "$a/tools/oxlint/anti-slop/rules/smuggled.ts"
git -C "$a" add -A
git -C "$a" -c user.email=t@t -c user.name=t commit -qm add
run_case "added tracked file fails" "$a" 1
run_case "added tracked file fails with GIT_DIR set" "$a" 1 gitdir

# The other direction: a file SHA256SUMS lists that is no longer tracked.
d="$tmp/deleted"
make_fixture "$d"
git -C "$d" rm -q tools/oxlint/anti-slop/rules/no-any.ts
git -C "$d" -c user.email=t@t -c user.name=t commit -qm rm
run_case "removed tracked file fails" "$d" 1

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
