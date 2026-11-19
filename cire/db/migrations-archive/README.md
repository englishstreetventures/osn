# Archived cire D1 migrations

Two chains that built the cire schema, which `../migrations/0001_initial.sql`
now stands for. That baseline is generated from a replay of `long-lived/`
(`scripts/cire-db-baseline.ts`), and builds exactly what each chain below
builds, table for table, index for index and trigger for trigger;
`cire/api/tests/db/ddl-lockstep.test.ts` replays them and fails if they differ.

| Directory | What it holds | Who recorded it |
| --- | --- | --- |
| `*.sql` here, `0001`–`0081` | The original chain, in the order production ran it | Production, file by file |
| `long-lived/` | Every migration a squash moved out of `../migrations`: the October 2026 baseline as `0001_initial.sql`, `0082`–`0091`, then timestamped files | Dev and production, by name and hash |

**Wrangler applies neither.** `wrangler d1 migrations apply` reads
`migrations_dir` from `cire/api/wrangler.toml`, which points at
`../db/migrations`, and applies only the files directly in it.

**The cire stack hands them to Alchemy on dev and production**
(`CIRE_DB_LONG_LIVED_MIGRATIONS` and `CIRE_DB_PRODUCTION_MIGRATIONS` in
`cire/infra/src/declaration.ts`, `wiki/shared/infrastructure-as-code.md`
§Migrations):

- `long-lived/` as written, each file in place of the same name in
  `../migrations` (the baseline): both databases recorded each by name and
  hash, so Alchemy finds every one unchanged and applies none of them again.
- On production only, a refusing placeholder under each name of the original
  chain that `long-lived/` lacks, never the file itself: production's ledger
  names each, so none runs, and a database whose ledger lacked one fails rather
  than run archived SQL (some of which deletes rows or drops columns).

A new database, a local one or an investigation stage's, gets `../migrations`
alone and builds from the baseline.

## What reads them

- The cire stack's dev and production migrations, above, and the release's
  ledger check, which refuses a production ledger missing a name of the
  original chain, or one of the long-lived chain behind a later applied file.
- `scripts/cire-db-migrate.ts`, behind `db:push` and `db:migrate:local`, compares a
  local database's ledger against both chains' names before it applies anything.
  A database that applied part of a chain must have applied all of it from the
  start of its chain (`CHAIN_STARTS` in that script) to the newest file here;
  otherwise wrangler would skip the baseline and the rest of the chain would
  never run there.
- `scripts/check-migration-orders.ts` refuses a new migration that sorts before
  a file in `long-lived/`, which dev and production hold.
- The data-migration tests replay them to prove what a migration did to rows
  that already existed — a back-fill that silently changed what a guest sees is
  the bug class they exist for:
  - the original chain: `cire/api/tests/db/migration-00*.test.ts` up to `0077`,
    the `0031` and `0037` blocks in `ddl-lockstep.test.ts`, and the `0063`,
    `0065`, `0073` and `0076` cases in `d1-integration.test.ts`;
    `cire/api/tests/test-helpers/archived-chain.ts` replays it up to a file once
    and hands each test its own copy;
  - the long-lived chain: `cire/api/tests/db/migration-0085`, `-0088`, `-0091`,
    `-20261021153838`, `-20261026040620`, `-20261106023546`, `-20261106103949`
    and `-20261118180052` (`.test.ts`), and the `0091`, task run time, seating
    plans, gift currency and gift account cases in `d1-integration.test.ts`.
- `shared/infra/tests/d1/ledger-conversion.test.ts` builds production's ledger
  from both chains with Wrangler, and proves on a local D1 that a squash sends
  dev and production no write.

## Rules

- **Only a squash adds files here**, and only to `long-lived/`: it moves every
  migration after the baseline in `../migrations` at once, each under the name a
  deployed ledger holds. New migrations go in `../migrations`, one timestamped
  file each, written by `db:generate`.
- **Never edit one.** They ran against production and dev; Alchemy refuses a
  recorded file whose bytes changed, and the release refuses it before its
  second approval.
- **Never delete one.** The ledger checks, the stack and the baseline tests read
  every file, and the deployed ledgers name each one.

How to squash, and when: `cire/db/README.md` §Squashing the chain.
