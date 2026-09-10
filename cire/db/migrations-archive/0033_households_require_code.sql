-- REVERSE households ≠ claim codes (product-owner decision, 2026-07-15): every
-- household must carry a claim code again. This UNDOES the shape 0032 introduced
-- (nullable `public_id` + partial unique index) and restores the original
-- invariant: `families.public_id` is `text NOT NULL` with a full column-level
-- UNIQUE. 0032 is deliberately KEPT in history (it already ran on production D1
-- and is tracked in `d1_migrations`; deleting it would desync prod from a fresh
-- D1) — this file is a forward reversing migration, not a `git revert`.
--
-- ⚠️ FAIL-LOUD ON NULL: a code-less household (`public_id IS NULL`) MUST NOT
-- exist when this runs. The NOT NULL rebuild below will NATURALLY FAIL (SQLite
-- NOT NULL constraint) on the copy INSERT if any `families.public_id` is NULL —
-- we do NOT coerce/mint a placeholder, because a NULL row means a real code-less
-- household got created and a human must mint it a proper `SURNAME-WORD-HASH`
-- code first, then re-run. Assumption (verified separately against prod): ZERO
-- `families` rows have a NULL `public_id`. A clean apply is the proof.
--
-- SQLite cannot ALTER a column to ADD NOT NULL or add a column-level UNIQUE in
-- place, so this is a full `families` REBUILD via the create-copy-drop-rename
-- `__keep_*` idiom (0006_multi_tenant.sql, mirrored by 0032). The mechanics that
-- make it FK-safe under D1 (which enforces foreign keys unconditionally and
-- cannot disable them — only defer, which does NOT suppress cascade actions):
--
--  1. `families` PARENTS four tables via `ON DELETE CASCADE`: `guests`,
--     `sessions`, `guest_account_links` (all directly on `family_id`) and — via
--     `guests` — `guest_events` and `rsvps`. `DROP TABLE families` runs an
--     implicit DELETE that FIRES those cascades. So the whole cascade subtree is
--     snapshotted into `__keep_*` tables BEFORE the drop and restored AFTER the
--     rebuilt parent exists.
--  2. Row identity is PRESERVED VERBATIM: the copy is `INSERT … SELECT id, … FROM
--     families` — every `families.id` value is carried across unchanged, so every
--     child FK (`guests.family_id`, `sessions.family_id`,
--     `guest_account_links.family_id`, and transitively `guest_events`/`rsvps`
--     via `guests.id`) still resolves to the same household. No child is
--     orphaned; the rebuild is invisible to the data.
--  3. Every statement is immediately FK-consistent; no pragmas are needed (and D1
--     wouldn't honour a `PRAGMA foreign_keys = OFF` mid-transaction anyway).
--
-- Recovery property (as in 0006/0032): the `__keep_*` snapshots are only dropped
-- in the FINAL statements, so if D1 ever part-applies this file the originals
-- remain on disk for manual recovery. This is a table-rebuild migration and
-- therefore FORWARD-ONLY — there is no down migration.
--
-- ── snapshot the families cascade subtree ───────────────────────────────────
CREATE TABLE `__keep_guests` AS SELECT * FROM `guests`;
--> statement-breakpoint
CREATE TABLE `__keep_sessions` AS SELECT * FROM `sessions`;
--> statement-breakpoint
CREATE TABLE `__keep_guest_events` AS SELECT * FROM `guest_events`;
--> statement-breakpoint
CREATE TABLE `__keep_rsvps` AS SELECT * FROM `rsvps`;
--> statement-breakpoint
CREATE TABLE `__keep_guest_account_links` AS SELECT * FROM `guest_account_links`;
--> statement-breakpoint
-- ── rebuild families with a NOT NULL public_id + inline column-level UNIQUE ──
-- Inline `UNIQUE` (an autoindex, no partial WHERE) restores the ORIGINAL
-- pre-0032 constraint — every household's code is globally unique and no NULL is
-- permitted. This drops the partial `families_public_id_uniq` index 0032 created
-- (it lived on the old table and vanishes with the DROP below; it is NOT
-- recreated here).
CREATE TABLE `__new_families` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL,
  `public_id` text NOT NULL UNIQUE,
  `family_name` text NOT NULL,
  `kind` text DEFAULT 'guest' NOT NULL,
  `code_shared_at` integer,
  `first_opened_at` integer,
  `deactivated_at` integer,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
-- Copy every row VERBATIM — id preserved so all child FKs stay valid. If ANY
-- `public_id` is NULL this INSERT fails on the NOT NULL constraint (fail-loud —
-- a code-less household must be given a code by a human before this migration
-- can apply). See the header note.
INSERT INTO `__new_families` (`id`, `wedding_id`, `public_id`, `family_name`, `kind`, `code_shared_at`, `first_opened_at`, `deactivated_at`, `created_at`, `updated_at`)
SELECT `id`, `wedding_id`, `public_id`, `family_name`, `kind`, `code_shared_at`, `first_opened_at`, `deactivated_at`, `created_at`, `updated_at` FROM `families`;
--> statement-breakpoint
-- Implicit DELETE here cascades into guests/sessions/guest_account_links (and
-- onwards into guest_events/rsvps) — all restored from the __keep_* tables below.
-- The partial `families_public_id_uniq` index is dropped along with the table.
DROP TABLE `families`;
--> statement-breakpoint
ALTER TABLE `__new_families` RENAME TO `families`;
--> statement-breakpoint
CREATE INDEX `families_family_name_idx` ON `families` (`family_name`);
--> statement-breakpoint
CREATE INDEX `families_wedding_idx` ON `families` (`wedding_id`);
--> statement-breakpoint
-- At most one host-preview family per wedding (unchanged partial unique index).
CREATE UNIQUE INDEX `families_one_host_per_wedding` ON `families` (`wedding_id`) WHERE `kind` = 'host';
--> statement-breakpoint
-- ── restore the preserved subtree (the rebuilt parent exists again) ─────────
INSERT INTO `guests` SELECT * FROM `__keep_guests`;
--> statement-breakpoint
INSERT INTO `sessions` SELECT * FROM `__keep_sessions`;
--> statement-breakpoint
INSERT INTO `guest_events` SELECT * FROM `__keep_guest_events`;
--> statement-breakpoint
INSERT INTO `rsvps` SELECT * FROM `__keep_rsvps`;
--> statement-breakpoint
INSERT INTO `guest_account_links` SELECT * FROM `__keep_guest_account_links`;
--> statement-breakpoint
DROP TABLE `__keep_guests`;
--> statement-breakpoint
DROP TABLE `__keep_sessions`;
--> statement-breakpoint
DROP TABLE `__keep_guest_events`;
--> statement-breakpoint
DROP TABLE `__keep_rsvps`;
--> statement-breakpoint
DROP TABLE `__keep_guest_account_links`;
