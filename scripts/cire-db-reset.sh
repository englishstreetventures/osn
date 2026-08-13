#!/usr/bin/env bash
# Drop every table in the DEV cire D1, including wrangler's `d1_migrations`
# ledger, so the next `d1 migrations apply` replays the whole migration history
# against an empty database.
#
#   bun run --cwd cire/db db:reset:dev      # scripts/cire-db-reset.sh --dev
#
# This is what makes the dev tier's data disposable: the deploy pipeline runs
# reset -> migrate -> seed on every merge to main, so dev never accumulates state
# and every deploy re-tests the migrations from 0001.
#
# DESTRUCTIVE, and unattended in CI. The only accepted target is `cire-db-dev`;
# the shared guard re-checks that against cire/api/wrangler.toml rather than
# trusting the name in this file. There is deliberately no flag that points it at
# production — resetting prod is not a thing this script can be talked into.
set -euo pipefail

if [ "${1:-}" != "--dev" ]; then
  echo "usage: $(basename "$0") --dev" >&2
  echo "  (--dev is required and is the only target; it wipes cire-db-dev)" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

# shellcheck source=scripts/cire-dev-db-guard.sh
. ./scripts/cire-dev-db-guard.sh
assert_cire_dev_db cire/api/wrangler.toml

echo "db:reset:dev: dropping all tables in $CIRE_DEV_DB_NAME"
bunx wrangler --config cire/api/wrangler.toml d1 execute "$CIRE_DEV_DB_NAME" \
  --env dev --remote --yes --file=cire/db/seed/dev-reset.sql

echo "db:reset:dev: done — run \`bun run --cwd cire/db db:migrate:dev\` next"
