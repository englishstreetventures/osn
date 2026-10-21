---
"@cire/api": patch
"@cire/db": patch
"@tools/e2e": patch
---

Move to drizzle-orm and drizzle-kit 1.0.0-rc.4, and make a database migration
one flat timestamped file.

`@cire/db`: `db:generate --name <snake_case>` writes the next migration as
`migrations/<YYYYMMDDHHMMSS>_<name>.sql`, diffing the working tree's schema
against `HEAD`'s; `migrations/meta/` is gone. `@cire/api`: the shared
`driverErrorText` replaces its own, and the test hooks follow drizzle 1.0's
bun:sqlite session. `@tools/e2e`: seeds through drizzle 1.0's client option.
