#!/usr/bin/env bash
# Seed the local cire D1, then (dev convenience) re-point the sample wedding's
# owner at your OSN profile so your signed-in account owns it. The dev seed
# (seed/dev-seed.sql) creates the sample wedding owned by the fixed dev id
# usr_dev_bootstrap_owner; set CIRE_DEV_OWNER_PROFILE_ID (in cire/db/.env or the
# environment) to override it after every seed/reset. Deployed environments have
# no seeded wedding at all — every real OSN user creates their own weddings via
# POST /api/organiser/weddings, so this script is local-only.
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
  echo "db:seed: CIRE_DEV_OWNER_PROFILE_ID unset - sample wedding owner stays the dev default usr_dev_bootstrap_owner (set it in cire/db/.env to own it from your account)"
fi
