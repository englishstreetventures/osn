# `@cire/db`

Drizzle schema, migrations, and dev-seed for the Cire D1 database.

## Layout

```
packages/db/
├── src/schema.ts         # Drizzle schema — single source of truth
├── drizzle.config.ts     # Drizzle Kit pointer to schema + migrations dir
├── migrations/           # Forward-only D1 migrations (committed)
│   ├── 0001_initial.sql
│   ├── 0002_add_rsvp_dietary.sql
│   ├── 0003_events_metadata_and_imports.sql
│   ├── 0004_perf_indices.sql
│   └── meta/_journal.json
└── seed/
    ├── data/             # Canonical seed data (single source of truth)
    │   ├── events.ts     # keyed-by-slug sample events
    │   ├── guests.ts     # sample families + guests (stable UUIDs)
    │   ├── wedding.ts    # bootstrap wedding row + DEV_OWNER_PROFILE_ID
    │   └── index.ts      # re-export — `@cire/db/seed`
    ├── generate.ts       # derives dev-seed.sql from ./data (bun run seed:generate)
    ├── seed.test.ts      # fails CI if dev-seed.sql drifts from ./data
    └── dev-seed.sql      # GENERATED local-D1 dev seed (events + families + guests)
```

## Scripts

Run from anywhere in the repo via the root aliases (`bun run db:push`, etc.) or
directly inside `packages/db`. Wrangler reads `apps/api/wrangler.toml` via the
`--config` flag baked into each script.

| Script           | What it does                                                                           |
| ---------------- | -------------------------------------------------------------------------------------- |
| `db:generate`    | `drizzle-kit generate` — diff `schema.ts` against the latest migration, emit a new one |
| `db:push`        | Apply all pending migrations to the **local** D1 (Miniflare-backed)                    |
| `db:push:remote` | Apply all pending migrations to the **production** D1. Coordinate with deploys.        |
| `db:seed`        | Apply `seed/dev-seed.sql` to the local D1 (idempotent — uses `INSERT OR IGNORE`)       |
| `db:reset`       | Wipe local D1 state, re-run migrations + seed. Destructive — local only.               |
| `db:studio`      | Launch Drizzle Studio for browsing the schema / writing one-off queries                |
| `seed:generate`  | Regenerate `seed/dev-seed.sql` from the canonical `seed/data/` modules                 |
| `test`           | Run the seed sync test (`bun test`) — fails if `dev-seed.sql` is out of sync           |

### Typical flows

**First-time setup**

```bash
bun install
bun run db:reset          # creates local D1 from scratch and seeds it
bun --cwd apps/api run dev
```

**After editing `schema.ts`**

```bash
bun run db:generate       # produces packages/db/migrations/000N_<desc>.sql
bun run db:push           # applies it locally
# review + commit the new migration
```

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

- D1 migrations are **forward-only**. No `DOWN` blocks. To retire a column, copy data into a new table and add a `DROP TABLE` / `ALTER` migration that performs the swap.
- After editing `schema.ts` AND any wrangler binding, regenerate types: `bunx wrangler --config apps/api/wrangler.toml types`.
- The dev seed is **not** applied to remote D1. Production data flows in via the organiser spreadsheet import (`/api/organiser/import/{preview,apply}`).
