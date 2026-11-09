-- An organisation member's role is 'admin' or 'member'. Two triggers refuse
-- any other value on insert and on update. A CHECK would need a copy-and-swap
-- rebuild of the table; the triggers move no rows.
--
-- Every statement runs again safely: the triggers are created only if absent,
-- and the last statement writes nothing when every stored role is in the set.
-- So a run that stops part-way finishes on the next one.
--
-- The last statement stops the migration if a stored row already holds another
-- role. It rewrites nothing: mapping such a row to 'member' or deleting it
-- would change who can act for an organisation. The update trigger refuses the
-- row with its fixed message, which names no row, profile or value.
--
-- If it stops, a later migration cannot fix it: wrangler and Alchemy apply
-- files in name order and stop at the first that fails, so every release that
-- applies osn migrations stops at this file. Recover in this order:
--   1. The owner, under the `production` Environment approval, reads counts
--      only, never rows: CI logs are public.
--      SELECT count(*) FROM organisation_members WHERE role NOT IN ('admin', 'member');
--   2. The owner decides whether each such row becomes 'member' or 'admin', or
--      is deleted. It is a permission decision.
--   3. Either the owner writes that change on the database, after which the
--      next release applies this file unchanged, or this file is rewritten
--      under the `migrations:rewrite` label, without which the
--      `Migration history` check refuses an edit to a merged migration.
CREATE TRIGGER IF NOT EXISTS `organisation_members_role_known` BEFORE INSERT ON `organisation_members`
WHEN NEW.`role` NOT IN ('admin', 'member')
BEGIN
	SELECT RAISE(ABORT, 'organisation member role is not admin or member');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `organisation_members_role_known_update` BEFORE UPDATE OF `role` ON `organisation_members`
WHEN NEW.`role` NOT IN ('admin', 'member')
BEGIN
	SELECT RAISE(ABORT, 'organisation member role is not admin or member');
END;--> statement-breakpoint
UPDATE `organisation_members` SET `role` = `role` WHERE `role` NOT IN ('admin', 'member');
