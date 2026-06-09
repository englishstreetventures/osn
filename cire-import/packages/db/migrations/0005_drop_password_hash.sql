-- Pre-existing drift: `password_hash` was dropped from `packages/db/src/schema.ts`
-- when the claim flow moved to publicId-only auth (PR-B added session cookies),
-- but the column lived on in migration 0001 as `text NOT NULL` — so any
-- `INSERT INTO families` from a fresh `db:push` errors with a NOT NULL
-- constraint failure (no code path supplies the column anymore).
--
-- Forward-only fix: drop the column. Surfaced while wiring up
-- `packages/db` scripts (db:push / db:seed / db:reset).
ALTER TABLE `families` DROP COLUMN `password_hash`;
