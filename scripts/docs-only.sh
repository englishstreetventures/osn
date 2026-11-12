#!/usr/bin/env bash
# Decides whether a change is prose only, given its changed files on stdin (one
# path per line). Prints "true" or "false" and exits 0, unless stdin is a
# terminal or /dev/null, which exits 1 instead of answering for no input.
#
# CI (.github/workflows/ci.yml, the `changes` job) skips its build, test,
# browser, D1, OpenAPI, migration and E2E jobs when this prints "true". Lint &
# Format, Scripts and the Secret scan run on every change.
#
# An ALLOWLIST, as scripts/changeset-required.sh is: "true" only when every
# path is known to be read by no build and no test, and "false" for anything
# else, no paths included. A wrong "true" lets code through with its tests
# never run; a wrong "false" costs a few minutes.
#
# Prose here is:
#   - anything under wiki/ or docs/. No build or test reads either (the script
#     tests' wiki checks run on fixtures).
#   - a changeset, .changeset/*.md, which only the release tooling and the
#     `Require changeset` workflow read.
#   - any other *.md, except where code reads markdown: AGENTS.md and
#     CLAUDE.md, and anything under .claude/, .agents/, .github/, scripts/ or
#     tools/ (the script tests read the skills and agent definitions; the
#     tools hold the metrics readers and vendored trees), or under a src/ or
#     tests/ directory, where a build or a test can import it. turbo.json
#     already leaves **/*.md out of every test task's inputs.
#
# Tests in scripts/tests/docs-only.cli.test.ts.
set -euo pipefail

if [ -t 0 ] || [ -c /dev/stdin ]; then
  echo "error: docs-only.sh reads the changed-file list on stdin." >&2
  echo "       git diff --name-only <base> HEAD | bash scripts/docs-only.sh" >&2
  exit 1
fi

# True when this one path is prose no build or test reads.
is_prose() {
  local f="$1"

  # A path that leaves the directory it names says nothing about where the
  # file is. `git diff --name-only` never prints one; refuse it anyway.
  case "$f" in
    /* | ../* | */../* | */.. | ./* | */./* | */.) return 1 ;;
  esac

  case "$f" in
    wiki/* | docs/*) return 0 ;;
    .changeset/*.md) return 0 ;;
    AGENTS.md | CLAUDE.md) return 1 ;;
    .claude/* | .agents/* | .github/* | scripts/* | tools/*) return 1 ;;
    src/* | */src/* | tests/* | */tests/*) return 1 ;;
    *.md) return 0 ;;
  esac
  return 1
}

seen=0
while IFS= read -r path || [ -n "$path" ]; do
  # Blank lines carry no path.
  [ -n "${path//[[:space:]]/}" ] || continue
  seen=1
  if ! is_prose "$path"; then
    echo false
    exit 0
  fi
done

if [ "$seen" -eq 1 ]; then echo true; else echo false; fi
