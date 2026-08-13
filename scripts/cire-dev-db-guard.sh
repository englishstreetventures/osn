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

# The dev database's real id, pinned. `database_name` in wrangler.toml is a
# label — wrangler resolves the target from `database_id` alone — so a block
# reading `database_name = "cire-db-dev"` above the live-wedding id would sail
# past the name check and drop every table. The name check stays (it catches the
# ordinary mistake with a clearer message), but this is the one that binds.
#
# Recreating cire-db-dev means editing this line as well as wrangler.toml. That
# is deliberate: two edits for a disposable database, none for the live one.
CIRE_DEV_DB_ID="bf0510eb-6998-4ee3-b5a0-833c646ef855"

# The live-wedding database, named so the refusal can say what it caught. Any
# id that is not CIRE_DEV_DB_ID is already refused; this only sharpens the
# message for the case that matters.
CIRE_PROD_DB_ID="6e835474-e0a7-4db9-8883-3247c3c891cd"

# Strips a TOML scalar down to its bare value: drops the key, the quotes (TOML
# accepts both ' and ", \047 is ') and any trailing comment. Every id in this
# file goes through this one normalisation — the dev block's and the ones it is
# compared against — because a guard that extracts one way and compares another
# fails open. It used to: extraction stripped any quote, the shared-id check
# matched a hard-coded \"$id\", so a single-quoted production id sharing the dev
# database passed the guard clean.
_CIRE_TOML_VALUE='
  sub(/^[^=]*=[[:space:]]*/, "")
  gsub(/["\047]/, "")
  sub(/[[:space:]]*(#.*)?$/, "")
'

# Prints the requested key from the [[env.dev.d1_databases]] table in
# cire/api/wrangler.toml, or nothing if the block or key is absent.
_cire_dev_d1_field() {
  local key="$1" toml="$2"
  awk -v key="$key" '
    /^[[:space:]]*\[\[env\.dev\.d1_databases\]\]/ { in_block = 1; next }
    # Any following table header ends the block. Leading whitespace is legal
    # TOML, and an anchored /^\[/ would miss an indented header — so the walk
    # would run on into the NEXT block and read its database_id as the dev one.
    /^[[:space:]]*\[/ { in_block = 0 }
    in_block && $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      '"$_CIRE_TOML_VALUE"'
      print
      exit
    }
  ' "$toml"
}

# Prints every database_id in the file, one per line, normalised the same way.
# Counts occurrences rather than matching lines, so two ids on one line are two.
_cire_all_d1_ids() {
  awk '
    /^[[:space:]]*database_id[[:space:]]*=/ {
      '"$_CIRE_TOML_VALUE"'
      print
    }
  ' "$1"
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

  if [ "$id" = "$CIRE_PROD_DB_ID" ]; then
    echo "cire dev-db guard: [env.dev] points at the PRODUCTION database ($id) under the name '$name'. Refusing." >&2
    return 1
  fi

  if [ "$id" != "$CIRE_DEV_DB_ID" ]; then
    echo "cire dev-db guard: [env.dev] database_id is $id, not the pinned dev database $CIRE_DEV_DB_ID. Refusing — a name alone does not make a database disposable." >&2
    return 1
  fi

  # The dev id must appear exactly once in the whole file. More than once means
  # some other env block (production, or the top-level local one) shares the
  # database, and "reset on every deploy" would wipe it.
  # `|| true` because grep exits 1 on no match, and a bare assignment carries
  # the substitution's status — under the callers' `set -e` a zero count would
  # abort here, losing the message below that says why.
  local occurrences
  occurrences="$(_cire_all_d1_ids "$toml" | grep -Fxc -- "$id" || true)"
  if [ "$occurrences" -ne 1 ]; then
    echo "cire dev-db guard: database_id $id appears $occurrences times in $toml — the dev tier is sharing a database with another environment. Refusing." >&2
    return 1
  fi

  echo "cire dev-db guard: target is $name ($id) — dedicated to the dev tier."
}
