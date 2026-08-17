#!/usr/bin/env bash
# Tests for changeset-required.sh. Plain-bash assertions (no bats dependency),
# matching the ethos of validate-changesets.test.sh next door. Each case feeds a
# fixture file list on stdin and asserts the printed verdict.
#
# Run: bash scripts/changeset-required.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
script="$here/changeset-required.sh"
pass=0
fail=0

run_case() {
  local name="$1" want="$2" files="$3"
  local got
  got=$(printf '%s' "$files" | bash "$script")
  if [ "$got" = "$want" ]; then
    echo "ok   - $name ($got)"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (got '$got', want '$want')"
    fail=$((fail + 1))
  fi
}

run_case "swift scaffolding only" skip \
  'shared/swift/OSNShared/Package.swift
pulse/ios/project.yml
.github/workflows/ci-swift.yml
.gitignore
scripts/changeset-required.sh'

run_case "wiki and top-level prose only" skip \
  'wiki/TODO.md
CLAUDE.md
README.md'

# Agent instructions: read by the coding agent, shipped by no package.
run_case "agent instructions only" skip \
  '.claude/commands/prep-pr.md
.claude/skills/obsidian/SKILL.md
CLAUDE.md'

run_case "agent instructions plus one source file" required \
  '.claude/commands/prep-pr.md
cire/api/src/index.ts'

run_case "source file in a versioned package" required \
  'osn/api/src/routes/graph.ts'

run_case "package.json bump" required \
  'pulse/web/package.json'

# The case a denylist would miss: a lockfile-only `bun update` changes what
# every deployed package builds from without touching a workspace file.
run_case "lockfile alone" required 'bun.lock'

run_case "root config alone" required 'turbo.json'
run_case "root tsconfig alone" required 'tsconfig.json'

run_case "swift plus one source file" required \
  'shared/swift/OSNShared/Package.swift
osn/api/src/index.ts'

run_case "empty diff" skip ''

# A `*` glob spans `/`, so an allowlisted prefix followed by `..` would
# otherwise escape it. Unreachable via `git diff --name-only`, guarded anyway.
run_case "dot-dot escape from an allowed prefix" required \
  'scripts/../osn/api/src/routes/graph.ts'

run_case "dot-dot escape to a root file" required 'wiki/../bun.lock'
run_case "absolute path" required '/etc/passwd'
run_case "single-dot segment" required 'wiki/./TODO.md'

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
