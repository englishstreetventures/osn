-- Data-layer review (2026-07-30), finding: the two `event_id` foreign keys
-- (`guest_events`, `rsvps`) were `ON DELETE NO ACTION` — the only non-cascading
-- child FKs in the schema. The import reconcile compensated with explicit
-- child deletes (rsvps → guest_events → events, services/import.ts), which
-- worked, but left a landmine: `weddings → events` IS `ON DELETE CASCADE`, so
-- the first wedding-delete flow (CLAUDE.md lists "delete" under the
-- `weddingOwner()` gate's remit) would have the events cascade slam into
-- NO ACTION children and fail — unless the sibling families→guests cascade
-- happened to fire first, which is ordering nobody should rely on.
--
-- Rebuild both child tables with `ON DELETE cascade` on `event_id`. SQLite
-- cannot ALTER a foreign-key action, so this is the create-copy-drop-rename
-- idiom (as 0006/0032/0033). No `__keep_*` snapshots are needed here: unlike
-- those parent-table rebuilds, `guest_events` and `rsvps` are LEAF tables —
-- dropping the old table cascades into nothing.
--
-- The rebuild also adds `rsvps_event_id_idx`: `rsvps_guest_event_uniq` leads
-- on guest_id, so the import's per-removed-event `DELETE FROM rsvps WHERE
-- event_id = ?` (and now the cascade's own child lookup) was a full scan.
-- `guest_events` already had its `guest_events_event_id_idx` equivalent.
CREATE TABLE `__new_guest_events` (
	`guest_id` text NOT NULL,
	`event_id` text NOT NULL,
	PRIMARY KEY(`guest_id`, `event_id`),
	FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_guest_events` (`guest_id`, `event_id`)
SELECT `guest_id`, `event_id` FROM `guest_events`;
--> statement-breakpoint
DROP TABLE `guest_events`;
--> statement-breakpoint
ALTER TABLE `__new_guest_events` RENAME TO `guest_events`;
--> statement-breakpoint
CREATE INDEX `guest_events_event_id_idx` ON `guest_events` (`event_id`);
--> statement-breakpoint
CREATE TABLE `__new_rsvps` (
	`id` text PRIMARY KEY NOT NULL,
	`guest_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text NOT NULL,
	`dietary` text DEFAULT '' NOT NULL,
	`dietary_consent_at` integer,
	`dietary_consent_version` text,
	`consent_source` text DEFAULT 'guest' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`guest_id`) REFERENCES `guests`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_rsvps` (`id`, `guest_id`, `event_id`, `status`, `dietary`, `dietary_consent_at`, `dietary_consent_version`, `consent_source`, `created_at`)
SELECT `id`, `guest_id`, `event_id`, `status`, `dietary`, `dietary_consent_at`, `dietary_consent_version`, `consent_source`, `created_at` FROM `rsvps`;
--> statement-breakpoint
DROP TABLE `rsvps`;
--> statement-breakpoint
ALTER TABLE `__new_rsvps` RENAME TO `rsvps`;
--> statement-breakpoint
CREATE UNIQUE INDEX `rsvps_guest_event_uniq` ON `rsvps` (`guest_id`, `event_id`);
--> statement-breakpoint
CREATE INDEX `rsvps_event_id_idx` ON `rsvps` (`event_id`);
