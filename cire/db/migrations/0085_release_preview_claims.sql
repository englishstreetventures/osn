-- A wedding's host preview household (`families.kind = 'host'`, the organiser's
-- "Preview invite" session) reads the gift list and holds no claim on it. This
-- sets every live claim such a household holds to `released`.
--
-- A release keeps the row, as a guest's release does: the couple's gift log and
-- gifts.csv show it as released. Only `status` and `updated_at` change; guests'
-- claims and every money gift are left as they are. `updated_at` is epoch
-- seconds, as drizzle's timestamp columns are.

UPDATE `registry_claims`
SET `status` = 'released', `updated_at` = unixepoch()
WHERE `status` <> 'released'
  AND `family_id` IN (SELECT `id` FROM `families` WHERE `kind` = 'host');
