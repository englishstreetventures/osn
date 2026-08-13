#!/usr/bin/env bash
# Shared guard for the two scripts that talk to a REMOTE cire D1 — cire-db-reset.sh
# (drops every table) and cire-db-seed.sh --dev (inserts the sample wedding).
#
# Both are destructive, both run unattended in CI on every merge, and both are one
# typo in cire/api/wrangler.toml away from pointing at the live-wedding database.
# So neither trusts the name it was given: this asserts, against the real config,
# that [env.dev]'s D1 is `cire-db-dev` AND that its database_id is shared with no
# other env block. Source it, then call `assert_cire_dev_db`.
#
# Exits non-zero (via `set -e` in the caller) with a loud message on any doubt.

CIRE_DEV_DB_NAME="cire-db-dev"

# Prints the requested key from the [[env.dev.d1_databases]] table in
# cire/api/wrangler.toml, or nothing if the block or key is absent.
_cire_dev_d1_field() {
  local key="$1" toml="$2"
  awk -v key="$key" '
    /^\[\[env\.dev\.d1_databases\]\]/ { in_block = 1; next }
    /^\[/ { in_block = 0 }
    in_block && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub(/^[^=]*=[[:space:]]*/, "")
      gsub(/"/, "")
      sub(/[[:space:]]*(#.*)?$/, "")
      print
      exit
    }
  ' "$toml"
}

# Fails unless cire/api/wrangler.toml's dev block names cire-db-dev and that
# database_id belongs to no other environment in the file.
assert_cire_dev_db() {
  local toml="${1:?assert_cire_dev_db: wrangler.toml path required}"

  if [ ! -f "$toml" ]; then
    echo "cire dev-db guard: cannot read $toml" >&2
    return 1
  fi

  local name id
  name="$(_cire_dev_d1_field database_name "$toml")"
  id="$(_cire_dev_d1_field database_id "$toml")"

  if [ "$name" != "$CIRE_DEV_DB_NAME" ]; then
    echo "cire dev-db guard: [env.dev] names D1 '${name:-<none>}', refusing — only '$CIRE_DEV_DB_NAME' is disposable." >&2
    return 1
  fi

  if [ -z "$id" ]; then
    echo "cire dev-db guard: [env.dev] has no database_id in $toml" >&2
    return 1
  fi

  # The dev id must appear exactly once in the whole file. More than once means
  # some other env block (production, or the top-level local one) shares the
  # database, and "reset on every deploy" would wipe it.
  local occurrences
  occurrences="$(grep -c "database_id[[:space:]]*=[[:space:]]*\"$id\"" "$toml")"
  if [ "$occurrences" -ne 1 ]; then
    echo "cire dev-db guard: database_id $id appears $occurrences times in $toml — the dev tier is sharing a database with another environment. Refusing." >&2
    return 1
  fi

  echo "cire dev-db guard: target is $name ($id) — dedicated to the dev tier."
}
