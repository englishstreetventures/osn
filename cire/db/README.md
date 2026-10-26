# `@cire/db`

Drizzle schema, migrations, and dev-seed for the Cire D1 database.

## Layout

```
cire/db/
├── src/schema.ts         # Drizzle schema — single source of truth
├── drizzle.config.ts     # Drizzle Kit pointer to schema + migrations dir
├── migrations/           # Forward-only D1 migrations (committed)
│   ├── 0001_initial.sql  # THE BASELINE — the whole schema in one file
│   ├── 0082_… – 0091_…   # numbered migrations after it
│   └── <YYYYMMDDHHMMSS>_<name>.sql  # every migration since, one file each (see below)
├── migrations-archive/   # 0001–0081, the chain the baseline stands for.
│                         # Wrangler never reads this; the ledger check and tests do.
├── seed/
│   ├── data/             # Canonical seed data (single source of truth)
│   │   ├── events.ts     # keyed-by-slug sample events
│   │   ├── guests.ts     # sample families + guests (stable UUIDs)
│   │   ├── wedding.ts    # bootstrap wedding row + DEV_OWNER_PROFILE_ID
│   │   └── index.ts      # re-export — `@cire/db/seed`
│   ├── generate.ts       # derives dev-seed.sql from ./data
│   └── dev-seed.sql      # GENERATED dev seed (events + families + guests)
└── tests/seed/
    ├── seed.test.ts      # fails CI if the generated .sql drifts from its source
    └── seed-applies.test.ts  # applies the seed to the migrated chain
```

## Scripts

Run from the repo root with `bun run --cwd cire/db <script>`. Wrangler reads
`cire/api/wrangler.toml` via the `--config` flag baked into each script. The
three scripts that apply migrations go through `scripts/cire-db-migrate.ts`,
which checks the target's ledger first (see the baseline section below) and
runs the wrangler `cire/api` installs from the lockfile. Without that install
it stops rather than fetch another version.

| Script             | What it does                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `db:generate`      | `scripts/db-generate.ts` — diff the working tree's `schema.ts` against `HEAD`'s, write one migration file (see below) |
| `db:push`          | Check the ledger, then apply pending migrations to the **local** D1 (Miniflare-backed)            |
| `db:migrate:local` | Same as `db:push`, named to match `:prod`                                                         |
| `db:migrate:prod`  | Check the ledger, then apply pending migrations to the **production** D1 (`--env production`). Coordinate with deploys. |
| `db:seed`          | Apply `seed/dev-seed.sql` to the local D1 (idempotent — uses `INSERT OR IGNORE`)                  |
| `db:reset`         | Wipe local D1 state, re-run migrations + seed. Destructive — local only.                          |
| `db:studio`        | Launch Drizzle Studio for browsing the schema / writing one-off queries                           |
| `seed:generate`    | Regenerate `seed/dev-seed.sql` from `seed/data/`                                                  |
| `test`             | Run the seed sync test (`bun test`) — fails if the generated `.sql` is out of sync                |

The remote script names its target database explicitly **and** passes `--env`.
Neither is optional: without `--env`, wrangler resolves the name against the
top-level config, the local `wrangler dev` binding, whose `cire-db` block
carries the production database id.

The dev tier's database is not migrated or seeded from here: the cire stack
(`cire/infra`) creates it in the dev account, applies the migrations, and
imports `seed/dev-seed.sql` on the first dev deploy and again whenever the file
changes.

Production is never reset and never seeded — no script here can do either.

### Typical flows

**First-time setup**

```bash
bun install
bun run --cwd cire/db db:reset   # creates local D1 from scratch and seeds it
bun run --cwd cire/api dev
```

**After editing `schema.ts`**

```bash
bun run --cwd cire/db db:generate --name <snake_case>
#   writes cire/db/migrations/<YYYYMMDDHHMMSS>_<name>.sql; add a rationale
#   header comment and review the SQL, without changing the shape it creates
bun run --cwd cire/db db:push       # applies it locally
# mirror the change in cire/api/src/db/setup.ts's DDL string — the
# ddl-lockstep test fails until all three surfaces agree
```

### The baseline, and why its filename matters

`migrations/0001_initial.sql` is not the first migration — it is the **whole
schema**. It builds exactly what the 81 files in `migrations-archive/` build,
and `cire/api/tests/db/ddl-lockstep.test.ts` replays both and fails if a single
table or index differs. D1 bills a from-zero build per schema statement, even
against empty tables. The archived chain spends 351 of them, most on SQLite
rebuilding whole tables for `ALTER TABLE ... DROP COLUMN`; the baseline spends
96, one `CREATE` per table and per index. `scripts/guard-d1-migration-cost.ts`
prices the live chain against the free tier's 100,000 rows written a day.

*Measured 2026-10-02 — `bun run scripts/guard-d1-migration-cost.ts --all` for
the baseline; the archive through the same script's `measureChain`.*

**Do not rename it.** `wrangler d1 migrations apply` skips any file already
named in the target database's `d1_migrations` ledger. Every deployed ledger
holds `0001_initial.sql`, so wrangler skips the baseline there and applies
only what follows it. Under any other name it would run the whole schema
against the live wedding database and fail on the first `CREATE TABLE`.
`ddl-lockstep.test.ts` pins the name.

**Apply migrations only through the scripts above.** Skipping the baseline is
right only on a database that had applied the whole archived chain. On one
that stopped part-way, wrangler would skip the baseline and never run the rest
of the archive, and nothing would say so. `scripts/cire-db-migrate.ts` reads
the target's ledger before anything is applied:

| The ledger holds | Verdict |
| --- | --- |
| nothing, or no `d1_migrations` table | a fresh database — apply |
| `0001_initial.sql` and live migrations, numbered after the archive | built from the baseline — apply |
| `0001_initial.sql` alone | apply if every table and index this baseline creates is stored there as written; otherwise an older baseline built it — **refuse** |
| archived migrations, every one from the start of their chain to the archive's newest | built from an older chain, complete — apply |
| archived migrations with any of that run missing | **refuse**, naming the missing files |
| a name that is not archived yet is numbered within the archive | a migration from outside this chain ran there — **refuse** |
| no `0001_initial.sql` | **refuse** |

A chain starts at one of the names in `CHAIN_STARTS` in
`scripts/cire-db-migrate.ts`: `0002`, where the original chain began, and
`0058`, the first migration after the previous baseline. The ledger read gives
up after two minutes, so a stalled call fails the deploy instead of holding it.

A bare `wrangler d1 migrations apply` makes no such check. A refused database
is brought level with the code that matches it, never by applying archived
files by hand: they can change schema the Worker serving that database still
reads. Production: re-run only the production cire-api job of an earlier run
whose commit is from before the files were archived and let it finish — it
applies them and deploys the matching Worker — then dispatch a release
(`wiki/shared/production-deploy.md` §4.1). Local: `db:reset`.

The archive lives outside `migrations_dir`, so nothing applies it. The tests
that replay it to prove what a migration did to existing rows are listed in
`migrations-archive/README.md`. Live migrations are numbered from `0082` to
`0091`, and timestamped after that; every name sorts after the archive's.

### Squashing the chain again

When `scripts/guard-d1-migration-cost.ts --all` nears its line, squash the
chain rather than raise the line:

1. **Every deployed database must already have applied every live migration.**
   For production, `bun run --cwd cire/api wrangler d1 migrations list cire-db
   --env production --remote` must say "No migrations to apply!". Running it
   through cire/api uses the wrangler the lockfile installs, never one fetched
   from the registry.
   A database that has not is refused by the ledger check after the squash, and
   every deploy to it stops until a pre-squash deploy run brings it level.
2. Append the first live migration after the baseline to `CHAIN_STARTS` in
   `scripts/cire-db-migrate.ts`. A database built from the current baseline
   holds that name first; without it in the list the check refuses every such
   database after the squash.
3. `git mv` every live migration after the baseline into `migrations-archive/`,
   under the name it has: every deployed ledger holds that name. Update the
   archive's range in `cire/api/tests/db/ddl-lockstep.test.ts` and
   `scripts/tests/cire-db-migrate.test.ts`, which assert it. The pull request
   needs the `migrations:rewrite` label, or the migration history guard refuses
   the moves.
4. Regenerate `0001_initial.sql` from a replay of the whole archive into
   `bun:sqlite` with `PRAGMA foreign_keys = ON`: each table's and then each
   index's `sqlite_master.sql`, in creation (`rowid`) order, leaving out
   `sqlite_%` objects, each statement followed by `;` and its own
   `--> statement-breakpoint`. Keep the header comment.
5. `bun run --cwd cire/db db:generate --name probe` must refuse with "no
   schema change": the new baseline and `schema.ts` agree.
6. Set the row in `scripts/d1-migration-cost-budgets.txt` to twice the new
   baseline, and update the figures in `migrations-archive/README.md`, this
   file and `wiki/conventions/bundle-size-guards.md`.
7. Run `bun run --cwd cire/api test`, `bun run --cwd cire/api test:d1` and
   `bun run test:scripts`.

### How a migration is made

A migration is one file, `migrations/<YYYYMMDDHHMMSS>_<name>.sql`, stamped in
UTC, and nothing else is committed with it: no journal, no snapshot. Two
branches that each add one touch no file in common, so neither blocks the
other. Wrangler applies the files in `migrations/` by leading number, then
name, so a timestamped file sorts after every numbered one, and it records each
by name in D1's `d1_migrations` table.

`db:generate` (`scripts/db-generate.ts`) has drizzle-kit write the SQL. It
snapshots `schema.ts` as it stands at `HEAD` (or `--from <rev>`) in a temporary
directory and diffs the working tree against that one snapshot. So:

- **Commit one migration with its schema change before generating the next.**
  It refuses while a `.sql` in `migrations/` is uncommitted, and refuses an
  empty diff: if the schema change is already committed, pass
  `--from <the commit before it>`.
- **A rename is never guessed.** On a terminal drizzle-kit asks; elsewhere it
  exits 2 and prints the `--hints` JSON to pass back.
- **A data-only or hand-written migration** is `--custom`: an empty file to
  fill in. It must hold a statement before it merges.
- **A copy-and-swap table rebuild is refused**: D1 enforces foreign keys, so
  dropping a parent table cascades into its children
  (`wiki/cire/cire-development.md` §Adding a column). A table nothing cascades
  from may be rebuilt by hand with `--custom`, under the `migrations:rewrite`
  label; `20261026040620_seating_plans.sql` rebuilds `seating_assignments` so.
- It writes a text primary key `NOT NULL` and a boolean default as `1` or `0`,
  as the deployed chain does.

Never run `drizzle-kit generate` or `drizzle-kit up` here directly. The first
writes a folder and a `meta/` journal wrangler never applies; the second
renames existing migrations, and a renamed file is applied again on every
deployed database.

What proves a migration right, in CI:

| Check | What it refuses |
| --- | --- |
| `cire/api/tests/db/ddl-lockstep.test.ts` | a chain that does not build what `schema.ts` and `setup.ts` declare, or anything in `migrations/` that is not a flat `.sql` with a statement |
| `scripts/check-migration-orders.ts` | new files that fail, or leave a different schema, when applied in name order (a fresh or production build) and after the base chain (the dev tier) |
| `scripts/guard-migration-history.ts` | an edited, deleted or renamed migration, a badly named or empty new one, a copy-and-swap rebuild — the `migrations:rewrite` label lifts all but the empty-file rule |

**Refresh local data after pulling**

```bash
bun run db:reset
```

## Seed contents

The canonical seed data lives in **`seed/data/`** (`events.ts`, `guests.ts`, `wedding.ts`) — a single source of truth consumed two ways:

- `cire/api/src/db/setup.ts#seedDb` imports it (via `@cire/db/seed`) for the in-memory test seed.
- `seed/generate.ts` **derives** `seed/dev-seed.sql` from it (the local-D1 seed). The SQL is a generated file — never hand-edit it. Run `bun run --cwd cire/db seed:generate` after changing anything under `seed/data/`. `seed.test.ts` fails CI if the committed SQL drifts.

This replaced the old hand-mirrored pair (`apps/api/src/data/{events,guests}.json` + a separate hand-written `dev-seed.sql`), which could silently drift.

Seeded shape:

- **5 events** (Catholic / Kitchen Tea / Mehendi / Hindu / Reception, Oct–Nov 2026, Sydney)
- **4 families** with stable UUIDs:
  - `TESTONE-IVY-AA11` — Ada (Testfamily)
  - `TESTTWO-OAK-BB22` — Bo, Cleo, Dot (Sampleton)
  - `TESTTRE-DEW-CC33` — Nori (Exampleton)
  - `TESTFOR-JOY-DD44` — Eli (Placeholder)
- **6 guests** + **15 invitation links** (per-event-per-guest)
- **A seating chart** on the Reception, in one plan, "Plan 1": 2 tables, Ada,
  Bo and Eli seated, Cleo not

Use `TESTFOR-JOY-DD44` as the dev claim code (Eli is invited to every event).

## Conventions

- Every schema change touches **three surfaces together**: the migration SQL,
  `src/schema.ts`, and the `DDL` string in `cire/api/src/db/setup.ts` —
  `cire/api/tests/db/ddl-lockstep.test.ts` diffs all three and fails on drift.
- D1 migrations are **forward-only**. No `DOWN` blocks. To retire a column, stop using it in one release and `ALTER TABLE … DROP COLUMN` in a later one (`wiki/cire/cire-development.md` §Adding a column).
- After editing `schema.ts` AND any wrangler binding, regenerate types: `bunx wrangler --config cire/api/wrangler.toml types`.
- The dev seed reaches the local D1 and the dev tier's (through the cire stack), never production. Production data flows in via the organiser spreadsheet import (`/api/organiser/import/{preview,apply}`).
