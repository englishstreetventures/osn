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
└── seed/dev-seed.sql     # Local-D1 dev seed (events + families + guests)
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

`seed/dev-seed.sql` mirrors the test fixtures in `apps/api/src/data/{events,guests}.json` (the test layer in `apps/api/src/db/setup.ts#seedDb` reads those JSON files, the dev seed re-states the same data as SQL). Keeping them in sync is currently manual — see `wiki/todo/db.md` for the DRY follow-up.

Seeded shape:

- **4 events** (Mehndi / Sangeet / Wedding / Reception, Sept 18-20 2026, Sydney)
- **4 families** with stable UUIDs:
  - `SHARMA-IVY-QM42` — Priya
  - `WILSON-OAK-7R2P` — James, Emma, Sophie
  - `MEENA-DEW-K9X3` — Auntie Meena
  - `PATEL-JOY-RK97` — Dev
- **6 guests** + **12 invitation links** (per-event-per-guest)

Use `PATEL-JOY-RK97` as the dev claim code (matches the LoginSection placeholder).

## Conventions

- D1 migrations are **forward-only**. No `DOWN` blocks. To retire a column, copy data into a new table and add a `DROP TABLE` / `ALTER` migration that performs the swap.
- After editing `schema.ts` AND any wrangler binding, regenerate types: `bunx wrangler --config apps/api/wrangler.toml types`.
- The dev seed is **not** applied to remote D1. Production data flows in via the organiser spreadsheet import (`/api/organiser/import/{preview,apply}`).
