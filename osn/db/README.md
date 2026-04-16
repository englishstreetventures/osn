# @osn/db

Drizzle schema + `DbLive` Effect layer for the **OSN identity database**
(users, passkeys, social graph, service accounts, pending registrations).

## Exports

- `@osn/db/schema` — all Drizzle tables and `$inferSelect`/`$inferInsert`
  types. `User`, `Passkey`, `Connection`, etc.
- `@osn/db/service` — the `Db` Effect context tag and `DbLive` layer,
  backed by a Bun SQLite file at `../../data/osn.db` (override via
  `OSN_DATABASE_URL`).

Runs against in-memory SQLite in tests (see `@shared/db-utils`).

## Scripts

```bash
bun run --cwd osn/db db:migrate   # generate a new Drizzle migration
bun run --cwd osn/db db:push      # apply the schema to the dev DB
bun run --cwd osn/db db:studio    # open Drizzle Studio
bun run --cwd osn/db db:seed      # run src/seed.ts
```

## Consumed by

`@osn/core`, `@osn/crypto` (tests only), `@osn/api`.
