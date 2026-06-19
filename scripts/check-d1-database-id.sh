#!/usr/bin/env bash
# CI guard: fail the build/deploy if cire/api/wrangler.toml still carries a
# PLACEHOLDER (or empty) D1 `database_id`.
#
# The bug class this guards against: shipping the Worker with the literal
# `database_id = "placeholder-replace-after-d1-create"` (the value scaffolded
# before the real D1 database is created) — or an empty id — would deploy
# cire-api pointed at no/an invalid database, silently breaking every D1 read
# and write in production. It's wired correctly today; this prevents a
# regression from a bad merge or a copy-pasted scaffold.
#
# Self-contained (grep only; no bun, no network) so it runs identically in CI
# and locally. Invoked by .github/workflows/deploy.yml before the cire-api
# deploy; runnable locally from anywhere in the repo.
set -euo pipefail

# Resolve to the repo root so the path below holds regardless of CWD.
# WRANGLER_TOML overrides the target (used by tests); defaults to the committed
# cire/api config relative to this script.
cd "$(dirname "$0")/.."
WRANGLER_TOML="${WRANGLER_TOML:-cire/api/wrangler.toml}"

if [[ ! -f "$WRANGLER_TOML" ]]; then
  echo "❌ check-d1-database-id: $WRANGLER_TOML not found" >&2
  exit 1
fi

fail() {
  echo "❌ check-d1-database-id: $WRANGLER_TOML still has a placeholder/empty D1 database_id." >&2
  echo "   Found: $1" >&2
  echo "" >&2
  echo "   Create the D1 database and paste its real UUID into every" >&2
  echo "   'database_id = \"...\"' line in $WRANGLER_TOML:" >&2
  echo "     cd cire/api && bunx wrangler d1 create cire-db" >&2
  echo "   then copy the printed database_id into wrangler.toml (top-level + any [env.*])." >&2
  exit 1
}

# 1) The exact scaffold sentinel.
if match="$(grep -n 'placeholder-replace-after-d1-create' "$WRANGLER_TOML" || true)"; then
  if [[ -n "$match" ]]; then
    fail "$match"
  fi
fi

# 2) An empty database_id (database_id = "" — never valid).
if match="$(grep -nE 'database_id[[:space:]]*=[[:space:]]*"[[:space:]]*"' "$WRANGLER_TOML" || true)"; then
  if [[ -n "$match" ]]; then
    fail "$match"
  fi
fi

# 3) Any "placeholder"-flavoured id, as a belt-and-braces catch for variants.
if match="$(grep -niE 'database_id[[:space:]]*=[[:space:]]*"[^"]*placeholder[^"]*"' "$WRANGLER_TOML" || true)"; then
  if [[ -n "$match" ]]; then
    fail "$match"
  fi
fi

echo "✅ check-d1-database-id: $WRANGLER_TOML D1 database_id is a real value (no placeholder)."
