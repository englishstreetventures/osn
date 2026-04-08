# @shared/db-utils

Shared database utilities used by both `@osn/db` and `@pulse/db`. Factors
out the boilerplate that every Drizzle-backed Effect DB layer would
otherwise have to duplicate.

## Exports

- `createDrizzleClient(url, schema)` — builds a `BunSQLiteDatabase`
  pointed at `url` (file path, `:memory:`, or `file:...`) with the given
  schema. Returns both the Drizzle instance and the raw Bun SQLite client
  so callers can run migrations.
- `makeDbLive(Tag, url, schema)` — given an Effect `Context.Tag` and a
  schema, returns a `Layer` that provides the Db service. Used by each
  db package's `service.ts`.

## Consumed by

`@osn/db`, `@pulse/db`. No direct runtime consumers — it's a pure utility
layer.
