#!/usr/bin/env bash
# Tests for cire-dev-db-guard.sh. Plain-bash assertions (no bats dependency),
# matching changeset-required.test.sh and validate-changesets.test.sh next door.
#
# This guard is the only thing between an unattended CI `DROP TABLE` loop and
# the live-wedding D1, and a weakened guard's failure mode is *passing* — so
# every refusal branch gets its own case. From outside, all five failures look
# alike; only a test can tell them apart.
#
# Run: bash scripts/cire-dev-db-guard.test.sh
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
repo_root="$(cd "$here/.." && pwd)"
# shellcheck source=./cire-dev-db-guard.sh
source "$here/cire-dev-db-guard.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
pass=0
fail=0

# want: "pass" or "refuse". Runs the guard against a fixture written from stdin.
run_case() {
  local name="$1" want="$2" toml="$tmp/${1// /_}.toml"
  cat >"$toml"
  local got
  if assert_cire_dev_db "$toml" >/dev/null 2>&1; then got=pass; else got=refuse; fi
  if [ "$got" = "$want" ]; then
    echo "ok   - $name ($got)"
    pass=$((pass + 1))
  else
    echo "FAIL - $name (got '$got', want '$want')"
    fail=$((fail + 1))
  fi
}

DEV_ID="bf0510eb-6998-4ee3-b5a0-833c646ef855"
PROD_ID="6e835474-e0a7-4db9-8883-3247c3c891cd"

run_case "dev block alone" pass <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "$DEV_ID"
EOF

run_case "dev and production with distinct ids" pass <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "$DEV_ID"

[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "$PROD_ID"
EOF

run_case "dev names the production database" refuse <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "$PROD_ID"
EOF

run_case "dev block has no database_id" refuse <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
EOF

run_case "no dev block at all" refuse <<EOF
[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "$PROD_ID"
EOF

run_case "production shares the dev id" refuse <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "$DEV_ID"

[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "$DEV_ID"
EOF

# The evasion the guard shipped with: extraction stripped any quote, the
# shared-id check matched a hard-coded double-quoted id. TOML accepts both
# forms, so a single-quoted production id sharing the dev database passed
# clean — and the next CI step drops every table.
run_case "production shares the dev id, single-quoted" refuse <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "$DEV_ID"

[[env.production.d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = '$DEV_ID'
EOF

run_case "dev block itself single-quoted" pass <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = 'cire-db-dev'
database_id = '$DEV_ID'
EOF

run_case "top-level local block shares the dev id" refuse <<EOF
[[d1_databases]]
binding = "DB"
database_name = "cire-db"
database_id = "$DEV_ID"

[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "$DEV_ID"
EOF

run_case "trailing comment on the dev id" pass <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"  # disposable
database_id = "$DEV_ID"  # reset on every merge
EOF

# `database_name` is a label; wrangler targets `database_id`. So the dangerous
# fixture is not a block that admits it points at production — it is one that
# says "cire-db-dev" over the live-wedding id. Only the pinned id catches this.
run_case "dev names cire-db-dev over the production id" refuse <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "$PROD_ID"
EOF

# Any id that is not the pinned one, even a plausible unknown, is refused: an
# unrecognised database might be anything, and the guard's job is to be sure.
run_case "dev points at an unrecognised database" refuse <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"
database_id = "00000000-1111-2222-3333-444444444444"
EOF

# Leading whitespace before a table header is legal TOML. The block-terminator
# used to be anchored /^\[/, so an indented header did not end the walk and the
# dev block "inherited" the next block's database_id. Here that would have
# yielded the dev id from a PRODUCTION block, unique in the file — a clean pass
# straight into the drop loop.
run_case "an indented header after a dev block with no id" refuse <<EOF
[[env.dev.d1_databases]]
binding = "DB"
database_name = "cire-db-dev"

  [[env.production.d1_databases]]
  binding = "DB"
  database_name = "cire-db"
  database_id = "$DEV_ID"
EOF

# A missing file must refuse, not fall through to the name check with an empty
# value (which would also refuse, but for the wrong reason and without saying
# the file was unreadable).
if assert_cire_dev_db "$tmp/nope.toml" >/dev/null 2>&1; then
  echo "FAIL - missing file (got 'pass', want 'refuse')"
  fail=$((fail + 1))
else
  echo "ok   - missing file (refuse)"
  pass=$((pass + 1))
fi

# The path argument is required — an unset variable at the call site must not
# silently become "check nothing". Run it in a subshell: the guard uses
# `${1:?...}`, which makes a non-interactive shell *exit*, and that would take
# this test script down with it.
if (assert_cire_dev_db) >/dev/null 2>&1; then
  echo "FAIL - no argument (got 'pass', want 'refuse')"
  fail=$((fail + 1))
else
  echo "ok   - no argument (refuse)"
  pass=$((pass + 1))
fi

# The real config must pass, or CI is broken for a reason no fixture will show.
if assert_cire_dev_db "$repo_root/cire/api/wrangler.toml" >/dev/null 2>&1; then
  echo "ok   - the committed cire/api/wrangler.toml (pass)"
  pass=$((pass + 1))
else
  echo "FAIL - the committed cire/api/wrangler.toml (got 'refuse', want 'pass')"
  fail=$((fail + 1))
fi

echo
echo "passed: $pass  failed: $fail"
[ "$fail" -eq 0 ]
