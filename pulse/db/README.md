# @pulse/db

Drizzle schema + `DbLive` Effect layer for the **Pulse events database**
(events, RSVPs).

## Exports

- `@pulse/db/schema` — Drizzle tables for `events`, `rsvps`, and their
  inferred types.
- `@pulse/db/service` — the `Db` Effect context tag and `DbLive` layer,
  backed by a Bun SQLite file at `../../data/pulse.db` (override via
  `PULSE_DATABASE_URL`).

In-memory SQLite in tests (see `@shared/db-utils`).

## Scripts

```bash
bun run --cwd pulse/db db:generate --name <snake_case>   # write the next migration (one timestamped file)
bun run --cwd pulse/db db:push
bun run --cwd pulse/db db:studio
bun run --cwd pulse/db db:seed
```

## Consumed by

`@pulse/api`.
