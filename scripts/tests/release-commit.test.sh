#!/usr/bin/env bash
# Tests for release-commit.sh, the commit-and-push step of
# .github/workflows/release.yml. Plain-bash assertions (no bats dependency),
# matching the sibling shell tests under scripts/tests/. Each case builds a
# throwaway repository with a bare remote, changes some of the paths the
# release job writes, runs the script there, and reads back what reached the
# remote. Needs git and nothing else, so it runs in ci.yml's script-tests job.
#
# Run: bash scripts/tests/release-commit.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
script="$here/release-commit.sh"
pass=0
fail=0

# The fixture repositories must not pick up the developer's own git config.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=release-test GIT_AUTHOR_EMAIL=release-test@example.invalid
export GIT_COMMITTER_NAME=release-test GIT_COMMITTER_EMAIL=release-test@example.invalid

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# A work tree laid out like the paths the release job touches, cloned from a
# bare remote so the script's plain `git push` has somewhere to go.
make_repo() {
  local name="$1"
  remote="$tmp/$name.git"
  work="$tmp/$name"
  git -c init.defaultBranch=main init -q --bare "$remote"
  git -c init.defaultBranch=main init -q "$work"
  mkdir -p "$work/pkg/a" "$work/.changeset" "$work/scripts"
  echo '{ "name": "@fixture/a", "version": "1.0.0" }' >"$work/pkg/a/package.json"
  echo '# @fixture/a' >"$work/pkg/a/CHANGELOG.md"
  echo '{}' >"$work/.changeset/config.json"
  echo '---' >"$work/.changeset/one.md"
  echo 'lock 1' >"$work/bun.lock"
  printf '# ceiling\n10   # start\n' >"$work/scripts/lint-warning-ceiling.txt"
  echo 'not released' >"$work/other.txt"
  git -C "$work" add -A
  git -C "$work" commit -qm "start"
  git -C "$work" remote add origin "$remote"
  git -C "$work" push -q -u origin main
}

run_script() {
  (cd "$work" && bash "$script") 2>&1
}

remote_subject() {
  git -C "$remote" log -1 --format=%s main
}

remote_files() {
  git -C "$remote" show --name-status --format= main
}

check() {
  local name="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name"
    echo "  got:  $got"
    echo "  want: $want"
    fail=$((fail + 1))
  fi
}

check_contains() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "ok   - $name"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (missing '$needle')"
    echo "  got: $haystack"
    fail=$((fail + 1))
  fi
}

# Nothing changed: no commit, exit 0.
make_repo nothing
out="$(run_script)"
check "nothing changed exits 0" "$?" "0"
check_contains "nothing changed says so" "$out" "Nothing to commit"
check "nothing changed pushes nothing" "$(remote_subject)" "start"

# Only the ceiling changed.
make_repo ceiling
printf '# ceiling\n8   # lowered\n' >"$work/scripts/lint-warning-ceiling.txt"
out="$(run_script)"
check "a lowered ceiling alone exits 0" "$?" "0"
check "a lowered ceiling alone is committed under its own message" "$(remote_subject)" "chore: lower the lint-warning ceiling"
check "that commit holds only the ceiling file" "$(remote_files)" "$(printf 'M\tscripts/lint-warning-ceiling.txt')"

# Only the version bump changed, including a consumed changeset.
make_repo version
echo '{ "name": "@fixture/a", "version": "1.0.1" }' >"$work/pkg/a/package.json"
printf '# @fixture/a\n\n## 1.0.1\n' >"$work/pkg/a/CHANGELOG.md"
rm "$work/.changeset/one.md"
echo 'lock 2' >"$work/bun.lock"
out="$(run_script)"
check "a version bump alone exits 0" "$?" "0"
check "a version bump alone keeps the version message" "$(remote_subject)" "chore: version packages"
check_contains "the consumed changeset's deletion is committed" "$(remote_files)" "$(printf 'D\t.changeset/one.md')"
check_contains "the lockfile is committed" "$(remote_files)" "$(printf 'M\tbun.lock')"

# Both changed.
make_repo both
echo '{ "name": "@fixture/a", "version": "1.0.1" }' >"$work/pkg/a/package.json"
printf '# ceiling\n7   # lowered\n' >"$work/scripts/lint-warning-ceiling.txt"
out="$(run_script)"
check "both changed exits 0" "$?" "0"
check "both changed names both in one commit" "$(remote_subject)" "chore: version packages, lower the lint-warning ceiling"

# A file outside the release job's paths is never committed.
make_repo unlisted
echo 'changed' >"$work/other.txt"
out="$(run_script)"
check "an unlisted change alone exits 0" "$?" "0"
check_contains "an unlisted change alone commits nothing" "$out" "Nothing to commit"
check "an unlisted change alone pushes nothing" "$(remote_subject)" "start"
echo '{ "name": "@fixture/a", "version": "1.0.1" }' >"$work/pkg/a/package.json"
out="$(run_script)"
check "beside a version bump, the unlisted file stays out of the commit" "$(remote_files)" "$(printf 'M\tpkg/a/package.json')"

# A push that loses a race to another merge fails the step, as before.
make_repo race
git clone -q "$remote" "$tmp/race-other"
echo 'elsewhere' >"$tmp/race-other/merged.txt"
git -C "$tmp/race-other" add merged.txt
git -C "$tmp/race-other" commit -qm "another merge"
git -C "$tmp/race-other" push -q origin main
echo '{ "name": "@fixture/a", "version": "1.0.1" }' >"$work/pkg/a/package.json"
out="$(run_script)"
code=$?
if [ "$code" -ne 0 ]; then
  echo "ok   - a push behind the remote fails"
  pass=$((pass + 1))
else
  echo "FAIL - a push behind the remote fails (exit 0)"
  echo "  output: $out"
  fail=$((fail + 1))
fi
check "a failed push leaves the remote as the other merge left it" "$(remote_subject)" "another merge"

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
