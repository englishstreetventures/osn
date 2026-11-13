# Archived cire D1 migrations (0001–0081)

These 81 files are the chain that built the cire schema, in the order
production ran them. `../migrations/0001_initial.sql` is a baseline that builds
exactly what they build, table for table and index for index;
`cire/api/tests/db/ddl-lockstep.test.ts` replays both and fails if they differ.

**Nothing applies them.** `wrangler d1 migrations apply` reads `migrations_dir`
from `cire/api/wrangler.toml`, which points at `../db/migrations` and not at
this directory. Production applied them, so its ledger holds their names, which
is why the baseline keeps the name `0001_initial.sql`: a migrator skips it there.
The cire stack, production's migrator, hands Alchemy a refusing placeholder
under each of these names, never the file itself, so a ledger that holds the
name converts and a database that lacks it fails rather than run archived SQL
(`wiki/shared/infrastructure-as-code.md` §Migrations).

## What reads them

- The cire stack's production migrations (`CIRE_DB_PRODUCTION_MIGRATIONS` in
  `cire/infra/src/declaration.ts`) and the release's ledger check, which refuses
  a production ledger missing any of these names.
- `scripts/cire-db-migrate.ts`, behind `db:push` and `db:migrate:local`, compares a
  local database's ledger against these names before it applies anything. A
  database that applied part of this chain must have applied all of it from
  the start of its chain (`CHAIN_STARTS` in that script) to the newest file
  here; otherwise wrangler would skip the baseline and the rest of the chain
  would never run there.
- The data-migration tests replay them to prove what a migration did to rows
  that already existed — a back-fill that silently changed what a guest sees is
  the bug class they exist for: `cire/api/tests/db/migration-*.test.ts`, the
  `0031` and `0037` blocks in `ddl-lockstep.test.ts`, and the `0063`, `0065`,
  `0073` and `0076` cases in `d1-integration.test.ts`.
  `cire/api/tests/test-helpers/archived-chain.ts` replays the chain up to a
  file once and hands each test its own copy.

## Rules

- **Only a squash adds files here**, and it moves the whole live chain after
  the baseline at once, each file under the name a deployed ledger holds. New
  migrations go in `../migrations`, one timestamped file each, written by
  `db:generate`.
- **Never edit one.** They ran against production; the record is what it is.
- **Never delete one.** The ledger checks, the production stack and the baseline
  test all read the whole archive, and production's ledger names each one.

How to squash, and when: `cire/db/README.md`.
