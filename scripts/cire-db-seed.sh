#!/usr/bin/env bash
# Seed the local cire D1, then (dev convenience) re-point the bootstrap wedding's
# owner at your OSN profile so your signed-in account owns it. Migration 0006
# seeds the inert sentinel owner usr_unclaimed_bootstrap (no real profile, gate
# fails closed); set CIRE_DEV_OWNER_PROFILE_ID (in cire/db/.env or the
# environment) to override it after every seed/reset. In deployed environments
# the owner instead comes from BOOTSTRAP_OWNER_PROFILE_ID via the worker's
# ensureBootstrapOwner fixup (see cire/api/src/index.ts) — this script is local-only.
#
# Invoked by the cire/db `db:seed` package script. Run with the cire/api worker
# STOPPED — wrangler dev holds the local D1 in memory and won't see external
# writes until it restarts.
set -euo pipefail

# Resolve to cire/db regardless of where this was invoked from, so the relative
# paths below (.env, seed file, ../api/wrangler.toml) always hold.
cd "$(dirname "$0")/../cire/db"

# Load cire/db/.env if present. `bun run --cwd` loads .env from the invocation
# dir, not the target, so we source it explicitly here instead of relying on it.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

WRANGLER=(bunx wrangler --config ../api/wrangler.toml d1 execute cire-db --local)

"${WRANGLER[@]}" --file=./seed/dev-seed.sql

if [ -n "${CIRE_DEV_OWNER_PROFILE_ID:-}" ]; then
  "${WRANGLER[@]}" --command \
    "UPDATE weddings SET owner_osn_profile_id='${CIRE_DEV_OWNER_PROFILE_ID}' WHERE id='wed_bootstrap';"
  echo "db:seed: wedding owner set to ${CIRE_DEV_OWNER_PROFILE_ID}"
else
  echo "db:seed: CIRE_DEV_OWNER_PROFILE_ID unset - wedding owner stays the inert sentinel usr_unclaimed_bootstrap (set it in cire/db/.env)"
fi
