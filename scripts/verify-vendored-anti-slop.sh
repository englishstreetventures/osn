#!/usr/bin/env bash
# tools/oxlint/anti-slop is excluded from oxfmt and ignored by oxlint (see its
# README), specifically so a re-vendor stays a plain copy with no formatting
# noise. That also means an edit to the vendored tree passes every other gate
# unnoticed. This is the check that would catch it — in two halves that run
# from one script because they guard the same tree.
#
# Half 1, always run: the tree matches its own checksums. `shasum -c` only
# verifies the paths SHA256SUMS lists — a file ADDED to the tree isn't in
# that list, so it has nothing to check it against and passes silently. The
# diff catches that half: it fails if the tracked file set drifts from
# SHA256SUMS in either direction, added or removed.
#
# That is still a self-certification: regenerate the manifest after an edit
# and the tree certifies whatever it now contains. Half 2 is the other side
# of that — it only runs when the caller passes a base ref, because it needs
# something to diff against and a pre-commit hook has none. With one, it
# checks the claim in `tools/oxlint/anti-slop/README.md` that this directory
# is a verbatim copy of one named upstream commit: a change to the vendored
# source without a matching change to the pinned commit is either an edit to
# upstream code (which the README says never happens) or a re-vendor that
# forgot to move the pin. Both want a human's eyes, and both are invisible to
# `shasum -c` — fetching the real upstream tarball to compare against would
# catch them for certain, but that's a network hop in a lint job and a flake
# whenever GitHub is slow, so this asserts the weaker property instead.
#
# `README.md` and `SHA256SUMS` are exempt from half 2. The README is
# repo-authored prose about the vendoring, not upstream source, and its own
# hash is inside SHA256SUMS, so editing one forces the other. Treating either
# as vendored source would fire half 2 on every PR that fixes a typo here.
#
# `git ls-files`, not `find`: it reads the tracked/staged set, which is what
# this check claims to cover; it lists symlinks (`find -type f` silently
# skips them); it needs no `sed` to strip a `./` prefix; and it works with no
# `bun install` — the CI callers run before or without one.
#
# Usage: verify-vendored-anti-slop.sh [base-ref] [repo-root]
#
# With no base-ref, only half 1 runs — that's what lefthook's pre-commit hook
# and the CI steps ahead of `bun install` use. With one, half 2 also runs; the
# base ref must already be fetched — `actions/checkout` clones at depth 1, so
# the caller either passes `fetch-depth: 0` or fetches the base SHA first.
set -euo pipefail

# Git exports GIT_DIR (and friends) to every hook it runs, and in a linked
# worktree that value is an absolute path, so it still resolves after the
# `cd` below. Left set, `git ls-files` bases itself on the work-tree root
# whatever the working directory is — under lefthook's pre-commit that made
# half 1 list all ~2300 tracked files instead of the vendored subtree's
# dozen, and the diff failed against a 21-line SHA256SUMS every time.
# Clearing the inherited variables puts discovery back on the working
# directory, which is what every git call below assumes.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

base="${1:-}"
root="${2:-$(cd "$(dirname "$0")/.." && pwd)}"
vendored="tools/oxlint/anti-slop"
readme="$vendored/README.md"

cd "$root/$vendored"
shasum -c SHA256SUMS
diff <(sed 's/^[0-9a-f]*  //' SHA256SUMS | sort) \
     <(git ls-files | grep -v '^SHA256SUMS$' | sort)
cd "$root"

if [ -z "$base" ]; then
  exit 0
fi

if ! git rev-parse --verify --quiet "$base^{commit}" >/dev/null; then
  echo "❌ anti-slop pin: base ref '$base' is not in this checkout." >&2
  echo "   Fetch it first — actions/checkout clones at depth 1." >&2
  exit 2
fi

# `git diff --name-only` over the vendored path, minus the two exempt files.
changed=$(
  git diff --name-only "$base" HEAD -- "$vendored" \
    | grep -v -e "^$vendored/README.md\$" -e "^$vendored/SHA256SUMS\$" || true
)

if [ -z "$changed" ]; then
  echo "✅ anti-slop pin: no vendored source changed against $base."
  exit 0
fi

# The pin as it reads on each side. A missing line is itself a failure: the
# README is the only record of which upstream commit this tree came from.
pin_at() {
  git show "$1:$readme" 2>/dev/null \
    | sed -n 's/.*pinned to commit `\([0-9a-f]\{7,40\}\)`.*/\1/p' \
    | head -n 1
}

pin_head=$(pin_at HEAD)
pin_base=$(pin_at "$base")

if [ -z "$pin_head" ]; then
  echo "❌ anti-slop pin: no 'pinned to commit \`<sha>\`' line in $readme at HEAD." >&2
  exit 1
fi

if [ "$pin_head" != "$pin_base" ]; then
  echo "✅ anti-slop pin: vendored source changed and the pin moved ($pin_base -> $pin_head)."
  exit 0
fi

echo "❌ anti-slop pin: vendored source changed while the pinned upstream commit did not." >&2
echo "" >&2
echo "   Pinned commit (unchanged against $base): $pin_head" >&2
echo "   Changed files:" >&2
echo "$changed" | sed 's/^/     /' >&2
echo "" >&2
echo "   $readme says this tree is a verbatim copy of that commit. Either" >&2
echo "   re-vendor from a newer upstream commit and update the pin, or — if the" >&2
echo "   edit is genuinely wanted — say so in the PR and move the pin anyway, so" >&2
echo "   the next reader knows the tree no longer matches upstream byte for byte." >&2
exit 1
