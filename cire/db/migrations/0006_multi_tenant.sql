-- Multi-tenancy scaffold: new `weddings` root table; families/events/imports
-- gain a NOT NULL `wedding_id` FK (ON DELETE CASCADE). Existing rows are
-- backfilled onto a bootstrap wedding.
--
-- sqlite cannot add a NOT NULL FK column in place (ADD COLUMN with a
-- REFERENCES clause requires DEFAULT NULL while FKs are enforced), so the
-- three tables are rebuilt via the create-copy-drop-rename idiom. D1 cannot
-- disable foreign_keys (only defer them), and DROP TABLE under enforced FKs
-- runs an implicit DELETE that FIRES ON DELETE CASCADE into child tables —
-- defer_foreign_keys does not suppress cascade actions (verified
-- empirically). So before rebuilding `families`, its cascade subtree
-- (guests, sessions and — via guests — guest_events, rsvps) is snapshotted
-- into __keep_* tables and restored once the rebuilt parents exist. Every
-- statement below is immediately FK-consistent; no pragmas required.
--
-- Recovery property: the __keep_* snapshots are only dropped in the final
-- statements, so if D1 ever part-applies this file the originals remain on
-- disk for manual recovery.
CREATE TABLE `weddings` (
  `id` text PRIMARY KEY NOT NULL,
  `slug` text NOT NULL,
  `display_name` text NOT NULL,
  `owner_osn_profile_id` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `weddings_slug_unique` ON `weddings` (`slug`);
--> statement-breakpoint
CREATE INDEX `weddings_owner_idx` ON `weddings` (`owner_osn_profile_id`);
--> statement-breakpoint
-- Bootstrap row for the existing bespoke wedding. The owner id is an INERT
-- sentinel ('usr_unclaimed_bootstrap'), NOT the real organiser: it satisfies
-- the NOT NULL owner column + the families/events FK backfill below while
-- matching no real OSN profile, so the organiser ownership gate fails CLOSED.
-- The real owner is NOT baked into this migration — it is supplied at runtime
-- from BOOTSTRAP_OWNER_PROFILE_ID and written by the Worker's bootstrap
-- owner-fixup (see cire/api/src/index.ts → ensureBootstrapOwner), which UPDATEs
-- this row away from the sentinel on first boot in a deployed environment.
INSERT INTO `weddings` (`id`, `slug`, `display_name`, `owner_osn_profile_id`, `created_at`, `updated_at`)
VALUES (
  'wed_bootstrap',
  'cire-wedding',
  'Cire Wedding',
  'usr_unclaimed_bootstrap',
  CAST(strftime('%s','now') AS INTEGER),
  CAST(strftime('%s','now') AS INTEGER)
);
--> statement-breakpoint
-- ── families (rebuild; preserve the cascade subtree first) ──────────────────
CREATE TABLE `__keep_guests` AS SELECT * FROM `guests`;
--> statement-breakpoint
CREATE TABLE `__keep_sessions` AS SELECT * FROM `sessions`;
--> statement-breakpoint
CREATE TABLE `__keep_guest_events` AS SELECT * FROM `guest_events`;
--> statement-breakpoint
CREATE TABLE `__keep_rsvps` AS SELECT * FROM `rsvps`;
--> statement-breakpoint
CREATE TABLE `__new_families` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL,
  `public_id` text NOT NULL,
  `family_name` text NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL,
  FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_families` (`id`, `wedding_id`, `public_id`, `family_name`, `created_at`, `updated_at`)
SELECT `id`, 'wed_bootstrap', `public_id`, `family_name`, `created_at`, `updated_at` FROM `families`;
--> statement-breakpoint
-- Implicit DELETE here cascades into guests/sessions (and onwards into
-- guest_events/rsvps) — restored from the __keep_* tables below.
DROP TABLE `families`;
--> statement-breakpoint
ALTER TABLE `__new_families` RENAME TO `families`;
--> statement-breakpoint
CREATE UNIQUE INDEX `families_public_id_unique` ON `families` (`public_id`);
--> statement-breakpoint
CREATE INDEX `families_family_name_idx` ON `families` (`family_name`);
--> statement-breakpoint
CREATE INDEX `families_wedding_idx` ON `families` (`wedding_id`);
--> statement-breakpoint
-- ── events (rebuild; its child tables are empty at this point, so the DROP
--    has no rows to cascade or violate) ──────────────────────────────────────
CREATE TABLE `__new_events` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL,
  `slug` text NOT NULL,
  `name` text NOT NULL,
  `date` text NOT NULL,
  `location` text NOT NULL,
  `description` text DEFAULT '' NOT NULL,
  `start_at` text NOT NULL,
  `end_at` text NOT NULL,
  `timezone` text NOT NULL,
  `address` text,
  `dress_code_description` text,
  `dress_code_palette` text,
  `pinterest_url` text,
  `maps_url` text,
  `sort_order` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_events` (`id`, `wedding_id`, `slug`, `name`, `date`, `location`, `description`, `start_at`, `end_at`, `timezone`, `address`, `dress_code_description`, `dress_code_palette`, `pinterest_url`, `maps_url`, `sort_order`)
SELECT `id`, 'wed_bootstrap', `slug`, `name`, `date`, `location`, `description`, `start_at`, `end_at`, `timezone`, `address`, `dress_code_description`, `dress_code_palette`, `pinterest_url`, `maps_url`, `sort_order` FROM `events`;
--> statement-breakpoint
DROP TABLE `events`;
--> statement-breakpoint
ALTER TABLE `__new_events` RENAME TO `events`;
--> statement-breakpoint
CREATE UNIQUE INDEX `events_slug_unique` ON `events` (`slug`);
--> statement-breakpoint
CREATE INDEX `events_sort_order_idx` ON `events` (`sort_order`);
--> statement-breakpoint
CREATE INDEX `events_wedding_idx` ON `events` (`wedding_id`);
--> statement-breakpoint
-- ── imports (rebuild; no child tables) ───────────────────────────────────────
CREATE TABLE `__new_imports` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL,
  `uploaded_at` integer NOT NULL,
  `format` text NOT NULL,
  `events_r2_key` text NOT NULL,
  `guests_r2_key` text NOT NULL,
  `summary` text NOT NULL,
  `status` text NOT NULL,
  `applied_at` integer,
  `reverted_at` integer,
  FOREIGN KEY (`wedding_id`) REFERENCES `weddings`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_imports` (`id`, `wedding_id`, `uploaded_at`, `format`, `events_r2_key`, `guests_r2_key`, `summary`, `status`, `applied_at`, `reverted_at`)
SELECT `id`, 'wed_bootstrap', `uploaded_at`, `format`, `events_r2_key`, `guests_r2_key`, `summary`, `status`, `applied_at`, `reverted_at` FROM `imports`;
--> statement-breakpoint
DROP TABLE `imports`;
--> statement-breakpoint
ALTER TABLE `__new_imports` RENAME TO `imports`;
--> statement-breakpoint
CREATE INDEX `imports_status_uploaded_at_idx` ON `imports` (`status`,`uploaded_at`);
--> statement-breakpoint
CREATE INDEX `imports_wedding_idx` ON `imports` (`wedding_id`);
--> statement-breakpoint
-- ── restore the preserved families subtree (all FK parents exist again) ─────
INSERT INTO `guests` SELECT * FROM `__keep_guests`;
--> statement-breakpoint
INSERT INTO `sessions` SELECT * FROM `__keep_sessions`;
--> statement-breakpoint
INSERT INTO `guest_events` SELECT * FROM `__keep_guest_events`;
--> statement-breakpoint
INSERT INTO `rsvps` SELECT * FROM `__keep_rsvps`;
--> statement-breakpoint
DROP TABLE `__keep_guests`;
--> statement-breakpoint
DROP TABLE `__keep_sessions`;
--> statement-breakpoint
DROP TABLE `__keep_guest_events`;
--> statement-breakpoint
DROP TABLE `__keep_rsvps`;
