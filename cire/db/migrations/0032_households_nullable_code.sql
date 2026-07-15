-- Households ≠ claim codes (platform Phase 0 PR 4).
--
-- Make `families.public_id` NULLABLE and swap the column-level UNIQUE for a
-- PARTIAL unique index (`WHERE public_id IS NOT NULL`), so a household can exist
-- with NO claim code — a manually-created guest-list record that has no
-- claimable invite until an organiser "issues" one — while codes that DO exist
-- stay globally unique (NULL never matches NULL in a UNIQUE index, so many
-- code-less households coexist).
--
-- SQLite cannot ALTER a column to drop NOT NULL or change a UNIQUE constraint in
-- place, so this is a full `families` REBUILD via the create-copy-drop-rename
-- `__keep_*` idiom introduced in 0006_multi_tenant.sql. The mechanics that make
-- it FK-safe under D1 (which enforces foreign keys unconditionally and cannot
-- disable them — only defer, which does NOT suppress cascade actions):
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
-- Recovery property (as in 0006): the `__keep_*` snapshots are only dropped in
-- the FINAL statements, so if D1 ever part-applies this file the originals remain
-- on disk for manual recovery. This is a table-rebuild migration and therefore
-- FORWARD-ONLY — there is no down migration.
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
-- ── rebuild families with a NULLABLE public_id (no inline UNIQUE) ────────────
CREATE TABLE `__new_families` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL,
  `public_id` text,
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
-- Copy every row VERBATIM — id preserved so all child FKs stay valid.
INSERT INTO `__new_families` (`id`, `wedding_id`, `public_id`, `family_name`, `kind`, `code_shared_at`, `first_opened_at`, `deactivated_at`, `created_at`, `updated_at`)
SELECT `id`, `wedding_id`, `public_id`, `family_name`, `kind`, `code_shared_at`, `first_opened_at`, `deactivated_at`, `created_at`, `updated_at` FROM `families`;
--> statement-breakpoint
-- Implicit DELETE here cascades into guests/sessions/guest_account_links (and
-- onwards into guest_events/rsvps) — all restored from the __keep_* tables below.
DROP TABLE `families`;
--> statement-breakpoint
ALTER TABLE `__new_families` RENAME TO `families`;
--> statement-breakpoint
-- PARTIAL unique index: codes stay globally unique, but many code-less
-- households (public_id IS NULL) coexist because NULL is excluded.
CREATE UNIQUE INDEX `families_public_id_uniq` ON `families` (`public_id`) WHERE `public_id` IS NOT NULL;
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
