#!/usr/bin/env bash
# Tests for verify-vendored-anti-slop.sh. Plain-bash assertions (no bats
# dependency), matching the sibling shell tests under scripts/.
#
# The guard has no injection point for its checksum half — it hardcodes
# `scripts/..` and `tools/oxlint/anti-slop` — so each case builds a throwaway
# git repo with that same shape, copies the real script in, and runs it
# there. That also means the cases never touch the repo's own vendored tree.
#
# Two sections: the checksum half (no base ref, exercises `shasum -c` and the
# file-set diff) and the pin half (a base ref, exercises the upstream-commit
# check). The pin fixtures regenerate SHA256SUMS after every change so the
# checksum half always agrees with whatever is on disk — that isolates what
# each case is actually testing, and it mirrors the real threat: an attacker
# who edits the vendored tree also regenerates the manifest, since leaving it
# stale would get caught by the checksum half alone. The pin check is what's
# left once the manifest can no longer out itself.
#
# Run: bash scripts/tests/verify-vendored-anti-slop.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
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

# A mode flip on a vendored file. Contents and the file set are both unchanged,
# so `shasum -c` and the name diff pass — this is the case that used to land
# with no guard firing at all.
m="$tmp/chmod"
make_fixture "$m"
git -C "$m" update-index --chmod=+x tools/oxlint/anti-slop/index.ts
git -C "$m" -c user.email=t@t -c user.name=t commit -qm chmod
run_case "executable bit on a vendored file fails" "$m" 1
run_case "executable bit on a vendored file fails with GIT_DIR set" "$m" 1 gitdir

# The other direction: a file SHA256SUMS lists that is no longer tracked.
d="$tmp/deleted"
make_fixture "$d"
git -C "$d" rm -q tools/oxlint/anti-slop/rules/no-any.ts
git -C "$d" -c user.email=t@t -c user.name=t commit -qm rm
run_case "removed tracked file fails" "$d" 1

# --- pin half: same guard, called with a base ref -------------------------

readme_with() {
  printf '# anti-slop (vendored)\n\nOxlint plugin from upstream,\npinned to commit `%s` (2026-08-14).\n' "$1"
}

# Recomputes SHA256SUMS from whatever is currently on disk, the same recipe
# tools/oxlint/anti-slop/README.md documents for a real re-vendor. Called
# after every change to the pin fixtures so the checksum half never confounds
# what a pin case is testing.
regen_sha() {
  (cd "$1/tools/oxlint/anti-slop" \
    && find . ! -type d ! -name SHA256SUMS | sed 's|^\./||' | LC_ALL=C sort \
    | xargs shasum -a 256 > SHA256SUMS)
}

# A repo with one vendored file, a README carrying the pin, and a matching
# SHA256SUMS — committed as the base, so every case below builds its HEAD on
# top.
make_fixture_pin() {
  local root="$1"
  mkdir -p "$root/scripts" "$root/tools/oxlint/anti-slop/rules"
  cp "$guard" "$root/scripts/verify-vendored-anti-slop.sh"
  printf 'export const plugin = {};\n' > "$root/tools/oxlint/anti-slop/index.ts"
  printf 'export const rule = {};\n' > "$root/tools/oxlint/anti-slop/rules/no-any.ts"
  readme_with aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$root/tools/oxlint/anti-slop/README.md"
  regen_sha "$root"
  git -C "$root" init -q
  git -C "$root" add -A
  git -C "$root" -c user.email=t@t -c user.name=t commit -qm base
}

commit_all() {
  git -C "$1" add -A
  git -C "$1" -c user.email=t@t -c user.name=t commit -qm head
}

# $3 is the expected exit status; $4, when "gitdir", exports GIT_DIR the way git
# does for the hooks it runs.
run_case_pin() {
  local name="$1" root="$2" want="$3" mode="${4:-clean}" got
  if [ "$mode" = "gitdir" ]; then
    GIT_DIR="$root/.git" bash "$root/scripts/verify-vendored-anti-slop.sh" HEAD~1 "$root" >/dev/null 2>&1
  else
    bash "$root/scripts/verify-vendored-anti-slop.sh" HEAD~1 "$root" >/dev/null 2>&1
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

# A branch that leaves the vendored tree alone has nothing to prove.
u="$tmp/untouched"
make_fixture_pin "$u"
printf 'unrelated\n' > "$u/scripts/other.sh"
commit_all "$u"
run_case_pin "untouched vendored tree passes" "$u" 0

# Git exports GIT_DIR to every hook it runs; the checksum half was broken by
# it once, so assert the pin half is not.
run_case_pin "untouched vendored tree passes with GIT_DIR set" "$u" 0 gitdir

# The case the pin half exists for: upstream source edited, manifest
# regenerated to match (so the checksum half alone would pass), pin left
# alone.
e="$tmp/edited"
make_fixture_pin "$e"
printf 'export const plugin = { tampered: true };\n' > "$e/tools/oxlint/anti-slop/index.ts"
regen_sha "$e"
commit_all "$e"
run_case_pin "edited vendored source with an unchanged pin fails" "$e" 1
run_case_pin "edited vendored source with an unchanged pin fails with GIT_DIR set" "$e" 1 gitdir

# A file added to the vendored tree is a change to it, pin or no pin — even
# with the manifest kept in sync.
a2="$tmp/added-pin"
make_fixture_pin "$a2"
printf 'export const rule = {};\n' > "$a2/tools/oxlint/anti-slop/rules/smuggled.ts"
regen_sha "$a2"
commit_all "$a2"
run_case_pin "a file added to the vendored tree with an unchanged pin fails" "$a2" 1

# ...and so is a removal.
d2="$tmp/deleted-pin"
make_fixture_pin "$d2"
rm "$d2/tools/oxlint/anti-slop/rules/no-any.ts"
regen_sha "$d2"
commit_all "$d2"
run_case_pin "a file removed from the vendored tree with an unchanged pin fails" "$d2" 1

# A real re-vendor: source changed, manifest regenerated, and the pin moved
# with it.
r="$tmp/revendored"
make_fixture_pin "$r"
printf 'export const plugin = { v2: true };\n' > "$r/tools/oxlint/anti-slop/index.ts"
readme_with bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb > "$r/tools/oxlint/anti-slop/README.md"
regen_sha "$r"
commit_all "$r"
run_case_pin "a re-vendor that moves the pin passes" "$r" 0

# The two exempt files. Prose about the vendoring is repo-authored, and its own
# hash lives in SHA256SUMS — so editing the README forces a regeneration, and
# treating either as vendored source would fire on every typo fix.
x="$tmp/exempt"
make_fixture_pin "$x"
readme_with aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa > "$x/tools/oxlint/anti-slop/README.md"
printf '\nA new paragraph about the re-vendor recipe.\n' >> "$x/tools/oxlint/anti-slop/README.md"
regen_sha "$x"
commit_all "$x"
run_case_pin "README.md and SHA256SUMS alone are exempt" "$x" 0

# A README that has lost its pin line cannot be checked against anything, and
# saying so beats passing quietly.
n="$tmp/nopin"
make_fixture_pin "$n"
printf 'export const plugin = { tampered: true };\n' > "$n/tools/oxlint/anti-slop/index.ts"
printf '# anti-slop (vendored)\n\nNo pin here any more.\n' > "$n/tools/oxlint/anti-slop/README.md"
regen_sha "$n"
commit_all "$n"
run_case_pin "a vendored change with no pin line at HEAD fails" "$n" 1

# A base ref the checkout does not have is a workflow bug, not a vendoring
# problem — exit 2 keeps the two apart.
b="$tmp/badbase"
make_fixture_pin "$b"
printf 'unrelated\n' > "$b/scripts/other.sh"
commit_all "$b"
bash "$b/scripts/verify-vendored-anti-slop.sh" no-such-ref "$b" >/dev/null 2>&1
got=$?
if [ "$got" -eq 2 ]; then
  echo "ok   - an unfetched base ref exits 2 (exit $got)"
  pass=$((pass + 1))
else
  echo "FAIL - an unfetched base ref exits 2 (got exit $got, want 2)"
  fail=$((fail + 1))
fi

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
