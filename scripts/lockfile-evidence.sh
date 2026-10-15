#!/usr/bin/env bash
# Print the evidence that a regenerated bun.lock moved only a branch's own
# packages. Read by review-pr Step 3, run from the root of the worktree whose
# bun.lock was just regenerated from main's. Tested by
# scripts/tests/lockfile-evidence.cli.test.ts.
#
#   bash scripts/lockfile-evidence.sh <merge-base> <branch-head-before-rebase> [main-ref]
#
# main-ref defaults to origin/main. Both commits are the ones recorded before the
# rebase: shell variables do not outlive one Bash call, so they are passed in,
# and each is verified as a commit before anything is read — an empty or wrong
# argument would otherwise make every comparison below answer about the wrong
# tree and look clean.
#
# Sections, in order:
#   1. whether main and the branch each changed bun.lock since the merge base
#   2. the dependency entries of every manifest the branch changed, merge base
#      against branch head (what the branch meant to change)
#   3. resolved name@version entries, main against the working tree (what the
#      regeneration changed) — every line should be one of section 2's packages
#      or something `bun why` traces to one; a dropped platform binary shows here
#   4. the same, merge base against branch head, for comparison
#   5. any name@version present in both main and the working tree whose entry
#      differs — a different source or integrity under an unchanged version
#   6. those manifests again, main against the working tree
#
# Exit 0 — printed, and section 5 is empty. Exit 1 — section 5 is not empty.
# Exit 3 — a bad argument, a git error, or no bun.lock here.
set -euo pipefail
# One collation for every sort and comm below.
export LC_ALL=C

die() { echo "lockfile-evidence.sh: $*" >&2; exit 3; }

[ $# -ge 2 ] || die "usage: lockfile-evidence.sh <merge-base> <branch-head-before-rebase> [main-ref]"
mb_arg=$1
orig_arg=$2
main_ref=${3:-origin/main}
for ref in "$mb_arg" "$orig_arg" "$main_ref"; do
  [ -n "$ref" ] || die "an argument is empty"
  git rev-parse -q --verify "$ref^{commit}" >/dev/null || die "$ref is not a commit"
done
mb=$(git rev-parse "$mb_arg^{commit}")
orig=$(git rev-parse "$orig_arg^{commit}")
[ -f bun.lock ] || die "no bun.lock in $(pwd); run this from the worktree root"

work=$(mktemp -d "${TMPDIR:-/tmp}/lockfile-evidence.XXXXXX") || die "mktemp failed"
trap 'rm -rf "$work"' EXIT

deps='{dependencies, devDependencies, peerDependencies, optionalDependencies, overrides}'

# Every `packages` entry as "name@version<TAB>entry", one per line. The entry is
# the array after the key, so a nested key and a top-level key that resolve to
# the same package compare equal.
entries() {
  { grep -E '^    "[^"]+": \["' || true; } | sed -E 's/^    "[^"]+": (\[.*\]),?$/\1/' |
    awk '{ match($0, /^\["[^"]+"/); key = substr($0, 3, RLENGTH - 3); print key "\t" $0 }' | sort -u
}

changed() {
  local status=0
  git diff --quiet "$1" "$2" -- bun.lock || status=$?
  case $status in
    0) echo no ;;
    1) echo yes ;;
    *) die "git diff $1 $2 failed" ;;
  esac
}

manifest_at() {
  if [ "$1" = WORKTREE ]; then
    if [ -f "$2" ]; then jq -S "$deps" "$2"; else echo '{}'; fi
  elif git cat-file -e "$1:$2" 2>/dev/null; then
    git show "$1:$2" | jq -S "$deps"
  else
    echo '{}'
  fi
}

set_diff() {
  comm -3 "$1" "$2" | awk '/^\t/ { print "+ " substr($0, 2); next } { print "- " $0 }'
}

git show "$main_ref:bun.lock" | entries >"$work/main"
entries <bun.lock >"$work/new"
git show "$mb:bun.lock" | entries >"$work/mb"
git show "$orig:bun.lock" | entries >"$work/orig"
for f in main new mb orig; do cut -f1 "$work/$f" | sort -u >"$work/$f.set"; done

manifests=$(git diff --name-only "$mb" "$orig" -- package.json '*/package.json')

echo "main ref: $main_ref ($(git rev-parse --short "$main_ref"))"
echo "merge base: $(git rev-parse --short "$mb") · branch head before rebase: $(git rev-parse --short "$orig")"
echo
echo "== bun.lock since the merge base"
echo "main changed bun.lock since the merge base: $(changed "$mb" "$main_ref")"
echo "the branch changed bun.lock since the merge base: $(changed "$mb" "$orig")"
echo
echo "== dependency entries the branch changed, merge base → branch head"
if [ -z "$manifests" ]; then echo "(no manifest changed)"; fi
for m in $manifests; do
  echo "-- $m"
  diff <(manifest_at "$mb" "$m") <(manifest_at "$orig" "$m") || true
done
echo
echo "== resolved packages, main → working tree ($(comm -13 "$work/main.set" "$work/new.set" | wc -l | tr -d ' ') added, $(comm -23 "$work/main.set" "$work/new.set" | wc -l | tr -d ' ') removed)"
set_diff "$work/main.set" "$work/new.set"
echo
echo "== resolved packages, merge base → branch head ($(comm -13 "$work/mb.set" "$work/orig.set" | wc -l | tr -d ' ') added, $(comm -23 "$work/mb.set" "$work/orig.set" | wc -l | tr -d ' ') removed)"
set_diff "$work/mb.set" "$work/orig.set"
echo

# Keys in both main and the working tree whose entries are not identical.
mismatch=$(awk -F'\t' 'NR == FNR { seen[$1] = seen[$1] "\n" $2; next }
  ($1 in seen) && index(seen[$1] "\n", "\n" $2 "\n") == 0 { print "  " $1 }' "$work/main" "$work/new" | sort -u)
if [ -z "$mismatch" ]; then
  echo "== same name@version, different entry: none"
else
  echo "== same name@version, different entry:"
  echo "$mismatch"
fi
echo
echo "== those manifests, main → working tree"
if [ -z "$manifests" ]; then echo "(no manifest changed)"; fi
for m in $manifests; do
  echo "-- $m"
  diff <(manifest_at "$main_ref" "$m") <(manifest_at WORKTREE "$m") || true
done

[ -z "$mismatch" ] || exit 1
exit 0
