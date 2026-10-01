-- Ownership moves from `weddings.owner_osn_profile_id` onto `wedding_hosts`,
-- as seats with role `owner`, so a wedding can have more than one owner and
-- every owner is equal.
--
-- 1. Every wedding's current owner gets an `owner` seat, dated from the
--    wedding's own `created_at` and attributed to themselves. The seat id is
--    `whost_` + a version-4 UUID, the shape the API mints. The CTE is
--    MATERIALIZED so each row's random hex is drawn once and every slice of
--    the id reads the same draw. An owner who already holds a seat on their
--    own wedding keeps that seat's id and history, and its role becomes
--    `owner`.
-- 2. The column's index goes, then the column. SQLite refuses to drop an
--    indexed column. `ALTER TABLE ... DROP COLUMN` rewrites `weddings` in
--    place; it is not a copy-and-swap, which on D1's enforced foreign keys
--    would cascade the drop into every child table.
--
-- `wedding_hosts.role` has no CHECK constraint, so `owner` needs no change to
-- the column itself.

WITH `seated` AS MATERIALIZED (
  SELECT `id`, `owner_osn_profile_id`, `created_at`, lower(hex(randomblob(16))) AS `h`
  FROM `weddings`
)
INSERT INTO `wedding_hosts` (`id`, `wedding_id`, `osn_profile_id`, `added_by_osn_profile_id`, `role`, `run_sheet_scope`, `created_at`)
SELECT
  'whost_' || substr(`h`, 1, 8) || '-' || substr(`h`, 9, 4) || '-4' || substr(`h`, 14, 3) || '-'
    || substr('89ab', (instr('0123456789abcdef', substr(`h`, 17, 1)) - 1) % 4 + 1, 1)
    || substr(`h`, 18, 3) || '-' || substr(`h`, 21, 12),
  `id`, `owner_osn_profile_id`, `owner_osn_profile_id`, 'owner', 'own', `created_at`
FROM `seated` WHERE true
ON CONFLICT (`wedding_id`, `osn_profile_id`) DO UPDATE SET `role` = 'owner';--> statement-breakpoint
DROP INDEX `weddings_owner_idx`;--> statement-breakpoint
ALTER TABLE `weddings` DROP COLUMN `owner_osn_profile_id`;
