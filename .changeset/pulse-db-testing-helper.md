---
"@pulse/db": patch
"@pulse/api": patch
---

Extract `@pulse/db/testing` helper so adding a column is a one-file change.

- New `@pulse/db/testing` export: `createSchemaSql()` derives `CREATE TABLE` + `CREATE INDEX` statements directly from the live Drizzle schema (FK-respecting topological order), and `applySchema(sqlite)` applies them to an in-memory SQLite handle.
- Replaces four hand-rolled DDL blocks in `pulse/db/tests/schema.test.ts`, `pulse/db/tests/seed.test.ts`, `pulse/api/tests/helpers/db.ts`, and `pulse/api/tests/services/zapBridge.test.ts` (pulse side) with `applySchema(sqlite)`.
- Drift-guard regression test asserts every schema table appears in the emitted SQL and that all declared indexes exist in the materialised in-memory database.

No runtime behaviour change — test infrastructure only.
