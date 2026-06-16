#!/usr/bin/env bash
# Tests for validate-changesets.sh. Plain-bash assertions (no bats dependency),
# matching the validator's own self-contained shell+jq ethos. Each case builds a
# throwaway fixture workspace and points the validator at it via CHANGESET_ROOT.
#
# Run: bash scripts/validate-changesets.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
validator="$here/validate-changesets.sh"
pass=0
fail=0

# Minimal fixture workspace: one real package the validator can discover.
make_fixture() {
  local root="$1"
  mkdir -p "$root/osn/api" "$root/.changeset"
  printf '{ "name": "@osn/api" }\n' > "$root/osn/api/package.json"
}

# Fixture with both a versioned package (@shared/crypto, not ignored) and a
# version-less package (@cire/api, ignored by changesets) — to exercise the
# mixed-changeset rule.
make_mixed_fixture() {
  local root="$1"
  mkdir -p "$root/shared/crypto" "$root/cire/api" "$root/.changeset"
  printf '{ "name": "@shared/crypto", "version": "1.0.0" }\n' > "$root/shared/crypto/package.json"
  printf '{ "name": "@cire/api" }\n' > "$root/cire/api/package.json"
}

run_case() {
  local name="$1" root="$2" want="$3"
  CHANGESET_ROOT="$root" bash "$validator" >/dev/null 2>&1
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

# Valid package reference → pass.
v="$tmp/valid"
make_fixture "$v"
printf -- '---\n"@osn/api": patch\n---\nsummary\n' > "$v/.changeset/change.md"
run_case "valid package name passes" "$v" 0

# Unknown package name (e.g. 'osn' instead of '@osn/api') → fail. This is the
# exact bug class the validator exists to catch.
i="$tmp/invalid"
make_fixture "$i"
printf -- '---\n"osn": patch\n---\nsummary\n' > "$i/.changeset/change.md"
run_case "unknown package name fails" "$i" 1

# Empty-frontmatter changeset (CI/infra-only, no package lines) → pass.
e="$tmp/empty"
make_fixture "$e"
printf -- '---\n---\ninfra only\n' > "$e/.changeset/change.md"
run_case "empty-frontmatter changeset passes" "$e" 0

# README.md is skipped even if it contains a package-like line → pass.
r="$tmp/readme"
make_fixture "$r"
printf -- '---\n"nope": patch\n---\n' > "$r/.changeset/README.md"
run_case "README.md is skipped" "$r" 0

# Empty workspace name set → fail fast (refuse to validate against nothing).
n="$tmp/noworkspaces"
mkdir -p "$n/.changeset"
printf -- '---\n"@osn/api": patch\n---\n' > "$n/.changeset/change.md"
run_case "empty workspace set fails fast" "$n" 1

# Mixed changeset: one file naming both an ignored (version-less @cire/api) and
# a versioned (@shared/crypto) package → fail. This is the exact class that
# crashes post-merge `changeset version`.
m="$tmp/mixed"
make_mixed_fixture "$m"
printf -- '---\n"@cire/api": minor\n"@shared/crypto": patch\n---\nsummary\n' > "$m/.changeset/change.md"
run_case "mixed ignored + versioned changeset fails" "$m" 1

# Same packages, but split across two changeset files (one ignored-only, one
# versioned-only) → pass. Guards against a cross-file false positive.
s="$tmp/split"
make_mixed_fixture "$s"
printf -- '---\n"@cire/api": minor\n---\nsummary\n' > "$s/.changeset/cire.md"
printf -- '---\n"@shared/crypto": patch\n---\nsummary\n' > "$s/.changeset/shared.md"
run_case "split ignored/versioned changesets pass" "$s" 0

# Single all-ignored changeset (only version-less packages) → pass.
g="$tmp/ignoredonly"
make_mixed_fixture "$g"
printf -- '---\n"@cire/api": minor\n---\nsummary\n' > "$g/.changeset/change.md"
run_case "all-ignored changeset passes" "$g" 0

echo
echo "passed: $pass, failed: $fail"
[ "$fail" -eq 0 ]
