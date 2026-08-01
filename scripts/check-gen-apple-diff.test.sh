#!/usr/bin/env bash
# Tests for check-gen-apple-diff.sh. Plain-bash assertions (no bats dependency),
# matching the guard's own self-contained git-only ethos. Each case builds a
# throwaway git repo and points the guard at it via GEN_APPLE_DIR.
#
# Run: bash scripts/check-gen-apple-diff.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
guard="$here/check-gen-apple-diff.sh"
pass=0
fail=0

# A repo with a committed, hand-edited stand-in for gen/apple: one tracked file,
# plus a .gitignore covering the build outputs the real project ignores.
make_fixture() {
  local root="$1"
  mkdir -p "$root/gen/apple/build"
  git -C "$root" init -q
  git -C "$root" config user.email test@example.com
  git -C "$root" config user.name test
  printf 'build/\nxcuserdata/\n' > "$root/gen/apple/.gitignore"
  printf 'deploymentTarget: 17.0\n' > "$root/gen/apple/project.yml"
  git -C "$root" add -A
  git -C "$root" commit -qm 'commit the project'
}

run_case() {
  local name="$1" root="$2" want="$3"
  (cd "$root" && GEN_APPLE_DIR="gen/apple" bash "$guard") >/dev/null 2>&1
  local got=$?
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

# Clean tree → pass. The acceptance case: CI must not go red on every PR.
c="$tmp/clean"
make_fixture "$c"
run_case "clean tree passes" "$c" 0

# A tracked file rewritten in place — what `tauri ios init` does to project.yml.
m="$tmp/modified"
make_fixture "$m"
printf 'deploymentTarget: 14.0\n' > "$m/gen/apple/project.yml"
run_case "modified tracked file fails" "$m" 1

# Staged, not yet committed. `git status --porcelain` reports it in the index
# column, so staging must not be a way to slip a regen past the guard.
s="$tmp/staged"
make_fixture "$s"
printf 'deploymentTarget: 14.0\n' > "$s/gen/apple/project.yml"
git -C "$s" add -A
run_case "staged change fails" "$s" 1

# A regen adds files as well as rewriting them.
u="$tmp/untracked"
make_fixture "$u"
printf '{}\n' > "$u/gen/apple/Podfile"
run_case "untracked file fails" "$u" 1

# Build output under an ignored path → pass. An ordinary `tauri ios build`
# writes here, and it must not fail the guard.
b="$tmp/ignored"
make_fixture "$b"
printf 'binary\n' > "$b/gen/apple/build/pulse.app"
run_case "ignored build output passes" "$b" 0

# Dirt elsewhere in the repo → pass. The guard is about one directory; a normal
# working tree is full of unrelated edits.
o="$tmp/outside"
make_fixture "$o"
printf 'edited\n' > "$o/README.md"
run_case "dirt outside gen/apple passes" "$o" 0

# Runs from a subdirectory: the guard cds to the repo root itself, so a dev who
# runs it from pulse/app gets the same answer.
d="$tmp/subdir"
make_fixture "$d"
mkdir -p "$d/deep/nested"
printf 'deploymentTarget: 14.0\n' > "$d/gen/apple/project.yml"
run_case "fails identically from a subdirectory" "$d/deep/nested" 1

# Missing directory → fail loudly rather than silently passing. A guard that
# reports "clean" because its target moved is worse than no guard.
n="$tmp/missing"
make_fixture "$n"
rm -rf "$n/gen/apple"
git -C "$n" commit -qam 'drop the project'
run_case "missing directory fails" "$n" 1

echo ""
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
