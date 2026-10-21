---
"@shared/db-utils": minor
"@shared/crypto": patch
"@osn/db": patch
"@osn/api": patch
"@pulse/db": patch
"@pulse/api": patch
"@zap/db": patch
"@zap/api": patch
---

Move to drizzle-orm and drizzle-kit 1.0.0-rc.4, and make a database migration
one flat timestamped file.

`@shared/db-utils`: `Db` is `SQLiteAsyncDatabase<"sync" | "async", unknown>` and
takes no schema type; `createDrizzleClient`, `createD1Db`, `makeDbLive` and
`makeD1DbLive` no longer take a schema. `driverErrorText` reads a failed
query's reason through its whole `cause` chain, since drizzle 1.0 wraps a
failed statement in `DrizzleQueryError` on bun:sqlite as on D1.

`@osn/api`: the handle and email races read the database's reason through
`driverErrorText`, so a handle taken in a race answers "Handle already taken"
on D1 instead of a database error.

`@osn/db`, `@pulse/db`, `@zap/db`: `db:generate --name <snake_case>` writes the
next migration as `drizzle/<YYYYMMDDHHMMSS>_<name>.sql`; `db:migrate` runs it
too. `drizzle/meta/` is gone. `@osn/db` declares `users.handle` unique through
the `users_handle_unique` index the database already holds.
