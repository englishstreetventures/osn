---
"@osn/db": patch
"@pulse/db": patch
"@zap/db": patch
---

Take better-sqlite3 13.0.3 (from 12.11.1) and @types/better-sqlite3 9.6.0 (from 7.6.13). Nothing in `src/` imports either — the real consumer is drizzle-kit, which resolves better-sqlite3 dynamically to back `db:migrate`, `db:push`, `db:studio` and `db:reset`. Verified by running `drizzle-kit generate` against 13.0.3 in all three packages. The two packages move together because the type definitions had drifted two majors behind the runtime.
