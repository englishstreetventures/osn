-- Per-family "code shared" timestamp. NULL = the organiser has never copied
-- this family's invite message; a value = when they last did (set by the
-- per-family "Copy message" button via POST .../families/:familyId/mark-shared).
--
-- Drives the remint "already sent out" warning: reminting rotates a family's
-- claim code and invalidates any already-shared link, so the bulk remint clears
-- this column back to NULL for every rotated family. Nullable with no default —
-- a pure forward-only ADD COLUMN that applies cleanly on D1/sqlite and leaves
-- every existing family at "never shared".
ALTER TABLE `families` ADD COLUMN `code_shared_at` integer;
