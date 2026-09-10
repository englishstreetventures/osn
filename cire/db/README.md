# `@cire/db`

Drizzle schema, migrations, and dev-seed for the Cire D1 database.

## Layout

```
cire/db/
├── src/schema.ts         # Drizzle schema — single source of truth
├── drizzle.config.ts     # Drizzle Kit pointer to schema + migrations dir
├── migrations/           # Forward-only D1 migrations (committed)
│   ├── 0001_initial.sql  # THE BASELINE — the whole schema in one file
│   ├── …                 # 0058 onwards; wrangler applies in NAME order
│   └── meta/             # drizzle-kit journal + 0057_snapshot.json (see below)
├── migrations-archive/   # 0001–0057 as they were, squashed 2026-09-10.
│                         # Wrangler never reads this; four tests do.
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
`cire/api/wrangler.toml` via the `--config` flag baked into each script.

| Script             | What it does                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------- |
| `db:generate`      | `drizzle-kit generate` — diff `schema.ts` against the latest migration, emit a new one            |
| `db:push`          | Apply all pending migrations to the **local** D1 (Miniflare-backed)                               |
| `db:migrate:local` | Same as `db:push`, named to match the `:dev` / `:prod` pair                                       |
| `db:migrate:dev`   | Apply pending migrations to the **dev** D1 (`cire-db-dev`, `--env dev`). CI runs this every merge |
| `db:migrate:prod`  | Apply pending migrations to the **production** D1 (`--env production`). Coordinate with deploys.  |
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
bun run --cwd cire/db db:generate   # emits cire/db/migrations/00NN_<desc>.sql (0058+)
# rename to a descriptive suffix, add a rationale header comment, review the SQL
bun run --cwd cire/db db:push       # applies it locally
# mirror the change in cire/api/src/db/setup.ts's DDL string — the
# ddl-lockstep test fails until all three surfaces agree
```

### The baseline, and why its filename matters

`migrations/0001_initial.sql` is not the first migration any more — it is the
**whole schema**, squashed out of the original 57 files on 2026-09-10
(xchromo/osn#981). Building a database from the chain cost 8,007 D1 rows written
and about 22,630 read, against a free-tier ceiling of 100,000 written a day
across the account; almost all of it was SQLite rebuilding whole tables for
`ALTER TABLE ... DROP COLUMN`, which D1 bills even when the table is empty.

**Do not rename it.** `wrangler d1 migrations apply` skips any file already
named in the target database's `d1_migrations` ledger. Production's ledger holds
`0001_initial.sql`, so wrangler skips the baseline and runs nothing. Under any
other name it would run the whole schema against the live wedding database and
fail on the first `CREATE TABLE`. `ddl-lockstep.test.ts` pins the name.

The originals live in `migrations-archive/`, outside `migrations_dir`, because
four tests replay them to prove what they did to real rows (`migration-0033`,
`-0041`, `-0044`, `-0052`, plus the `0031` and `0037` blocks in
`ddl-lockstep.test.ts`). Nothing applies them. New migrations start at `0058`.

### How `meta/` relates to the hand-authored migrations

`wrangler d1 migrations apply` runs the `.sql` files in NAME order and tracks
them in D1's own `d1_migrations` table — it never reads `meta/_journal.json`.
The journal + latest snapshot exist for **drizzle-kit only**, so `db:generate`
can diff `schema.ts` against the current shape and number the next file
correctly. The 2026-09-10 squash trimmed the journal to a single entry and replaced the six
stale snapshots with one that actually matches `schema.ts`. That entry reads
**`idx: 57`, `tag: 0001_initial`** — the tag names the baseline file, and the
index says 57 migrations have happened, so `db:generate` numbers the next one
`0058` rather than reusing a number the archive already spent. Its snapshot is
`meta/0057_snapshot.json`, named for the index. Change one and you must change
the other. `bunx drizzle-kit generate` on a clean tree prints "No schema
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
