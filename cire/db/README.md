# `@cire/db`

Drizzle schema, migrations, and dev-seed for the Cire D1 database.

## Layout

```
cire/db/
├── src/schema.ts         # Drizzle schema — single source of truth
├── drizzle.config.ts     # Drizzle Kit pointer to schema + migrations dir
├── migrations/           # Forward-only D1 migrations (committed)
│   ├── 0001_initial.sql  # THE BASELINE — the whole schema in one file
│   ├── …                 # 0082 onwards; wrangler applies in NAME order
│   └── meta/             # drizzle-kit journal + 0081_snapshot.json (see below)
├── migrations-archive/   # 0001–0081, the chain the baseline stands for.
│                         # Wrangler never reads this; the ledger check and tests do.
└── seed/
    ├── data/             # Canonical seed data (single source of truth)
    │   ├── events.ts     # keyed-by-slug sample events
    │   ├── guests.ts     # sample families + guests (stable UUIDs)
    │   ├── wedding.ts    # bootstrap wedding row + DEV_OWNER_PROFILE_ID
    │   └── index.ts      # re-export — `@cire/db/seed`
    ├── generate.ts       # derives dev-seed.sql from ./data + dev-reset.sql from schema.ts
    ├── seed.test.ts      # fails CI if either generated .sql drifts from its source
    ├── dev-seed.sql      # GENERATED dev seed (events + families + guests)
    └── dev-reset.sql     # GENERATED DROP of every table incl. d1_migrations (dev only)
```

## Scripts

Run from the repo root with `bun run --cwd cire/db <script>`. Wrangler reads
`cire/api/wrangler.toml` via the `--config` flag baked into each script. The
four scripts that apply migrations go through `scripts/cire-db-migrate.ts`,
which checks the target's ledger first (see the baseline section below) and
runs the wrangler `cire/api` installs from the lockfile. Without that install
it stops rather than fetch another version.

| Script             | What it does                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `db:generate`      | `drizzle-kit generate` — diff `schema.ts` against the latest migration, emit a new one            |
| `db:push`          | Check the ledger, then apply pending migrations to the **local** D1 (Miniflare-backed)            |
| `db:migrate:local` | Same as `db:push`, named to match the `:dev` / `:prod` pair                                       |
| `db:migrate:dev`   | Check the ledger, then apply pending migrations to the **dev** D1 (`cire-db-dev`, `--env dev`). CI runs this every merge |
| `db:migrate:prod`  | Check the ledger, then apply pending migrations to the **production** D1 (`--env production`). Coordinate with deploys. |
| `db:seed`          | Apply `seed/dev-seed.sql` to the local D1 (idempotent — uses `INSERT OR IGNORE`)                  |
| `db:seed:dev`      | Same seed against `cire-db-dev`. Guarded — refuses any other remote database. Nightly, with the reset above |
| `db:reset`         | Wipe local D1 state, re-run migrations + seed. Destructive — local only.                          |
| `db:reset:dev`     | Drop every table in `cire-db-dev` incl. `d1_migrations`. Destructive — dev only, no prod flag. Run nightly by `cire-dev-db-rebuild.yml`, not on merge |
| `db:studio`        | Launch Drizzle Studio for browsing the schema / writing one-off queries                           |
| `seed:generate`    | Regenerate `seed/dev-seed.sql` and `seed/dev-reset.sql` from `seed/data/` + `src/schema.ts`       |
| `test`             | Run the seed sync tests (`bun test`) — fail if either generated `.sql` is out of sync             |

Every remote script names its target database explicitly **and** passes `--env`.
Neither is optional: without `--env`, wrangler resolves the name against the
top-level config, so a script meant for dev silently hits production. The two
destructive dev scripts also re-check `cire/api/wrangler.toml` at run time
(`scripts/cire-dev-db-guard.ts`) and abort unless `[env.dev]` really is
`cire-db-dev` with an id no other environment shares.

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
bun run --cwd cire/db db:generate   # emits cire/db/migrations/00NN_<desc>.sql (0082+)
# rename to a descriptive suffix, add a rationale header comment, review the SQL
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
reads. Production: approve the deploy run of a commit from before the files
were archived and let it finish — it applies them and deploys the matching
Worker — then re-run the refused job. Dev: run `cire-dev-db-rebuild.yml`.
Local: `db:reset`.

The archive lives outside `migrations_dir`, so nothing applies it. The tests
that replay it to prove what a migration did to existing rows are listed in
`migrations-archive/README.md`. New migrations start at `0082`.

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
3. `git mv` every live migration after the baseline into `migrations-archive/`.
   The archive stays contiguous from `0001`.
4. Regenerate `0001_initial.sql` from a replay of the whole archive into
   `bun:sqlite` with `PRAGMA foreign_keys = ON`: each table's and then each
   index's `sqlite_master.sql`, in creation (`rowid`) order, leaving out
   `sqlite_%` objects, each statement followed by `;` and its own
   `--> statement-breakpoint`. Keep the header comment.
5. Trim `meta/_journal.json` to one entry: `tag: 0001_initial`, `idx` the
   archive's highest number. Keep only the snapshot named for that index.
   `bunx drizzle-kit generate` must print "No schema changes, nothing to
   migrate".
6. Set the row in `scripts/d1-migration-cost-budgets.txt` to twice the new
   baseline, and update the figures in `migrations-archive/README.md`, this
   file and `wiki/conventions/bundle-size-guards.md`.
7. Run `bun run --cwd cire/api test`, `bun run --cwd cire/api test:d1` and
   `bun run test:scripts`.

### How `meta/` relates to the hand-authored migrations

`wrangler d1 migrations apply` runs the `.sql` files in NAME order and tracks
them in D1's own `d1_migrations` table — it never reads `meta/_journal.json`.
The journal + latest snapshot exist for **drizzle-kit only**, so `db:generate`
can diff `schema.ts` against the current shape and number the next file
correctly. The journal's first entry reads **`idx: 81`, `tag: 0001_initial`**
— the tag names the baseline file, and the index says 81 migrations have
happened, so `db:generate` numbers the next one `0082` rather than reusing a
number the archive already spent. Its snapshot is `meta/0081_snapshot.json`,
named for the index. Change one and you must change the other. `bunx drizzle-kit generate` on a clean tree prints "No schema
changes, nothing to migrate", which is the check that the baseline and
`schema.ts` still agree. Keep it working: `db:generate` refreshes
the journal + snapshot itself, but a **hand-written** migration must be
accompanied by re-syncing `meta/` — easiest is to make the matching `schema.ts`
edit first and let `db:generate` produce the SQL skeleton, then edit the SQL
(add comments / data backfill) without changing the shape it creates.

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

Use `TESTFOR-JOY-DD44` as the dev claim code (Eli is invited to every event).

## Conventions

- Every schema change touches **three surfaces together**: the migration SQL,
  `src/schema.ts`, and the `DDL` string in `cire/api/src/db/setup.ts` —
  `cire/api/tests/db/ddl-lockstep.test.ts` diffs all three and fails on drift.
- D1 migrations are **forward-only**. No `DOWN` blocks. To retire a column, copy data into a new table and add a `DROP TABLE` / `ALTER` migration that performs the swap.
- After editing `schema.ts` AND any wrangler binding, regenerate types: `bunx wrangler --config cire/api/wrangler.toml types`.
- The dev seed is **not** applied to remote D1. Production data flows in via the organiser spreadsheet import (`/api/organiser/import/{preview,apply}`).
