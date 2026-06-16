#!/usr/bin/env bash
# Reset a Drizzle SQLite package's local database: delete the DB file, re-push
# the schema, then seed if the package ships a seed file. Shared by the osn/db,
# pulse/db, and zap/db `db:reset` package scripts — each passes its own DB-url
# env-var name and default path.
#
# Runs in the caller's cwd (the package dir, set by `bun run`) on purpose, so
# the `bun run db:push` / `db:seed` calls resolve that package's own scripts and
# the default path stays relative to it.
#
# Usage: bash ../../scripts/db-reset.sh <DB_URL_ENV_VAR> <default-db-path>
set -euo pipefail

env_var="${1:?db-reset: missing DB url env-var name}"
default_path="${2:?db-reset: missing default db path}"

# Indirect expansion: honour the env override if set, else the default path.
db_path="${!env_var:-$default_path}"

# Guard the delete: only ever `rm` a *.db file that resolves inside this repo.
# The path is operator-supplied (env override), so constrain it before deleting
# to turn an unbounded `rm` into a bounded one.
case "$db_path" in
  *.db) ;;
  *)
    echo "db-reset: refusing to delete non-.db path: $db_path" >&2
    exit 1
    ;;
esac

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
parent_dir="$(dirname "$db_path")"
if [ -d "$parent_dir" ]; then
  abs_path="$(cd "$parent_dir" && pwd)/$(basename "$db_path")"
  case "$abs_path" in
    "$repo_root"/*) rm -f "$abs_path" ;;
    *)
      echo "db-reset: refusing to delete path outside repo: $abs_path (repo: $repo_root)" >&2
      exit 1
      ;;
  esac
else
  # Parent dir absent → no DB file to remove; db:push will create it.
  echo "db-reset: $db_path parent dir missing, nothing to remove"
fi

bun run db:push
if [ -f src/seed.ts ]; then
  bun run db:seed
else
  echo "db:reset: no seed file, skipping"
fi
