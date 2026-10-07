#!/usr/bin/env bash
# Seed a cire D1 with the sample wedding from seed/dev-seed.sql, then re-point
# that wedding's owner seat at a real OSN profile so a signed-in account owns it.
# The seed gives the owner seat (wedding_hosts id DEV_OWNER_SEAT_ID in
# cire/db/seed/data/wedding.ts) to the fixed dev id usr_dev_bootstrap_owner; set
# CIRE_DEV_OWNER_PROFILE_ID (in cire/db/.env, or as a GitHub environment variable
# for the dev tier) to override it after every seed/reset.
#
#   bun run --cwd cire/db db:seed          # local miniflare D1
#   bun run --cwd cire/db db:seed:dev      # remote cire-db-dev (this script --dev)
#
# PRODUCTION IS NEVER SEEDED. Every real OSN user creates their own weddings via
# POST /api/organiser/weddings, so a sample wedding there would be someone's
# stray data. There is no flag here that targets it.
#
# Local mode: run with the cire/api worker STOPPED — wrangler dev holds the local
# D1 in memory and won't see external writes until it restarts.
set -euo pipefail

TARGET="local"
if [ "${1:-}" = "--dev" ]; then
  TARGET="dev"
elif [ -n "${1:-}" ]; then
  echo "usage: $(basename "$0") [--dev]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# Resolve to cire/db regardless of where this was invoked from, so the relative
# paths below (.env, seed file, ../api/wrangler.toml) always hold.
cd "$REPO_ROOT/cire/db"

# Load cire/db/.env if present. `bun run --cwd` loads .env from the invocation
# dir, not the target, so we source it explicitly here instead of relying on it.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# The wrangler cire/api installs from the lockfile — the version that migrated
# the database — never one fetched from the registry: on dev this runs with an
# API token that can write to the database.
WRANGLER_BIN="$REPO_ROOT/cire/api/node_modules/.bin/wrangler"
if [ ! -x "$WRANGLER_BIN" ]; then
  echo "db:seed: cire/api has no wrangler of its own; run \`bun install --frozen-lockfile\` first" >&2
  exit 1
fi

if [ "$TARGET" = "dev" ]; then
  # Same guard the reset script uses: prove against wrangler.toml that [env.dev]
  # really is the disposable cire-db-dev and shares its id with nothing else.
  bun "$REPO_ROOT/scripts/cire-dev-db-guard.ts" "$REPO_ROOT/cire/api/wrangler.toml"
  # The guard above just proved [env.dev]'s D1 is named exactly this, so it is
  # safe to use as a literal target here.
  CIRE_DEV_DB_NAME="cire-db-dev"
  WRANGLER=("$WRANGLER_BIN" --config ../api/wrangler.toml d1 execute "$CIRE_DEV_DB_NAME" --env dev --remote --yes)
else
  WRANGLER=("$WRANGLER_BIN" --config ../api/wrangler.toml d1 execute cire-db --local)
fi

"${WRANGLER[@]}" --file=./seed/dev-seed.sql

# Repoint the sample wedding at a real account. This runs on BOTH targets:
# locally the id comes from cire/db/.env, on dev from the CIRE_DEV_OWNER_PROFILE_ID
# variable the deploy workflow passes in (a GitHub environment variable, so no
# profile id is committed here).
#
# It is not a nicety on dev. The seed owns the wedding as usr_dev_bootstrap_owner,
# an id no account holds, and the nightly rebuild resets and reseeds the tier —
# so without the override the seeded wedding, its 494 guests and its comped
# Crimson tier (every paid module unlocked) are invisible to whoever signs in to
# test them, and any wedding a tester makes by hand is wiped on the next rebuild.
if [ -n "${CIRE_DEV_OWNER_PROFILE_ID:-}" ]; then
  # The value is interpolated into a SQL string literal below. It comes from
  # cire/db/.env, the workflow, or the ambient environment — trusted-ish, but a
  # stray apostrophe closes the literal and the rest of the value runs as SQL
  # against the whole database. Profile ids are `usr_` + url-safe base64, so an
  # exact match on that shape costs nothing and removes the question.
  # `[[ =~ ]]` matches the whole value; grep matches line by line and would
  # pass a value whose second line carries SQL.
  if ! [[ "$CIRE_DEV_OWNER_PROFILE_ID" =~ ^usr_[A-Za-z0-9_-]+$ ]]; then
    echo "db:seed: CIRE_DEV_OWNER_PROFILE_ID='${CIRE_DEV_OWNER_PROFILE_ID}' is not a profile id (expected usr_ followed by letters, digits, - or _). Refusing." >&2
    exit 1
  fi
  # Ownership is a wedding_hosts seat. The owner seat keeps its fixed id and
  # takes the new profile; any other seat that profile already holds on the
  # sample wedding goes first, since a profile holds one seat per wedding.
  OWNER_SEAT_ID="whost_d1f0c4a2-0000-4000-8000-000000000000"
  "${WRANGLER[@]}" --command \
    "DELETE FROM wedding_hosts WHERE wedding_id='wed_bootstrap' AND osn_profile_id='${CIRE_DEV_OWNER_PROFILE_ID}' AND id<>'${OWNER_SEAT_ID}'; UPDATE wedding_hosts SET osn_profile_id='${CIRE_DEV_OWNER_PROFILE_ID}', added_by_osn_profile_id='${CIRE_DEV_OWNER_PROFILE_ID}', role='owner' WHERE id='${OWNER_SEAT_ID}';"
  echo "db:seed: wedding owner seat set to ${CIRE_DEV_OWNER_PROFILE_ID}"
elif [ "$TARGET" = "dev" ]; then
  echo "db:seed: CIRE_DEV_OWNER_PROFILE_ID unset - the seeded wedding stays owned by usr_dev_bootstrap_owner and NO real account can open it. Set it as a variable on the dev environment in GitHub."
else
  echo "db:seed: CIRE_DEV_OWNER_PROFILE_ID unset - sample wedding owner stays the dev default usr_dev_bootstrap_owner (set it in cire/db/.env to own it from your account)"
fi
