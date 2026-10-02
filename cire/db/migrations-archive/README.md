# Archived cire D1 migrations (0001–0081)

These 81 files are the chain that built the cire schema, in the order
production ran them. `../migrations/0001_initial.sql` is a baseline that builds
exactly what they build, table for table and index for index;
`cire/api/tests/db/ddl-lockstep.test.ts` replays both and fails if they differ.

**Nothing applies them.** `wrangler d1 migrations apply` reads `migrations_dir`
from `cire/api/wrangler.toml`, which points at `../db/migrations` and not at
this directory. A deployed database that applied them holds their names in its
`d1_migrations` ledger, which is why the baseline keeps the name
`0001_initial.sql`: wrangler skips it there.

## What reads them

- `scripts/cire-db-migrate.ts`, behind every `db:migrate:*` script, compares a
  target database's ledger against these names before it applies anything. A
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
  the baseline at once, keeping the numbers contiguous from `0001`. New
  migrations go in `../migrations`, numbered after the highest number here.
- **Never edit one.** They ran against production; the record is what it is.
- **Never delete one.** The ledger check and the baseline test both read the
  whole archive.

How to squash, and when: `cire/db/README.md`.
