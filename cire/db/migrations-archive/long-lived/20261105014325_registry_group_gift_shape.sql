-- A group gift is a cash fund with `allow_partial` set and a target. A CHECK
-- cannot be added to `registry_items` without a copy-and-swap, which would
-- cascade into `registry_claims`, so two triggers refuse any other shape: the
-- flag on a gift to reserve, the flag without a target, and a flag that is
-- neither 0 nor 1. The insert one covers a new row; the update one covers a
-- write that changes the kind, the flag or the target.
CREATE TRIGGER `registry_items_group_gift_shape` BEFORE INSERT ON `registry_items`
WHEN NEW.`allow_partial` NOT IN (0, 1)
  OR (NEW.`allow_partial` = 1 AND (NEW.`kind` <> 'cash_fund' OR NEW.`target_minor` IS NULL))
BEGIN
	SELECT RAISE(ABORT, 'a group gift is a cash fund with a target');
END;--> statement-breakpoint
CREATE TRIGGER `registry_items_group_gift_shape_update` BEFORE UPDATE OF `kind`, `allow_partial`, `target_minor` ON `registry_items`
WHEN NEW.`allow_partial` NOT IN (0, 1)
  OR (NEW.`allow_partial` = 1 AND (NEW.`kind` <> 'cash_fund' OR NEW.`target_minor` IS NULL))
BEGIN
	SELECT RAISE(ABORT, 'a group gift is a cash fund with a target');
END;
