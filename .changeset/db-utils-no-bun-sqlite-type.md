---
"@shared/db-utils": patch
---

`createDrizzleClient` no longer refers to the `bun:sqlite` module, even as a
type, so a Worker type-check without Bun types can import this package's D1
helpers. Drizzle now opens the database from the path itself
(`drizzle(dbPath, { schema })`, which calls `new Database(dbPath)` as the old code
did), and foreign keys are still switched on through `$client`. New tests cover
`createDrizzleClient` and `makeDbLive` directly.

The package's own `check` now enforces this: `tsconfig.json` carries Workers
types only, and a new `tests/tsconfig.json` type-checks the tests with
`bun-types`, which no config did before.
