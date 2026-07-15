-- Change history (guest+event editor E3, [[guest-event-editor]] §4).
--
-- Generalise the `imports` table into a change history so every applied change —
-- a spreadsheet import today, an in-app editor save (E5/E6) tomorrow — can be
-- reverted to its exact pre-change state via a BEFORE-IMAGE snapshot.
--
-- Three ADDITIVE columns (pure `ADD COLUMN`, no table rebuild — D1/sqlite allows
-- `ADD COLUMN` in place; none of these change a constraint or drop NOT NULL):
--
--  1. `kind` — `'import' | 'editor'`. NOT NULL with a DEFAULT so it can be added
--     in place and every legacy row back-fills onto `'import'` (they were all
--     spreadsheet imports). The editor save path (E5/E6) writes `'editor'`; the
--     CSV import path keeps the default.
--
--  2. `before_events_r2_key` / `before_guests_r2_key` — the R2 keys of the
--     wedding's CURRENT-state snapshot CSVs, captured at apply time BEFORE the
--     change mutates anything (the change's before-image). NULLABLE: legacy rows
--     predate the before-image and have none — revert falls back to the old
--     "re-apply the previous import's sheets" heuristic for those.
--
-- Forward-only, additive; no down migration needed (nothing to undo structurally
-- and the defaults are safe).
ALTER TABLE `imports` ADD COLUMN `kind` text DEFAULT 'import' NOT NULL;--> statement-breakpoint
ALTER TABLE `imports` ADD COLUMN `before_events_r2_key` text;--> statement-breakpoint
ALTER TABLE `imports` ADD COLUMN `before_guests_r2_key` text;
