-- A money gift keeps the name of the cash fund it was given to.
--
-- `item_id` is SET NULL when the couple delete a listing, and a fund can be
-- renamed, so the gift log reads the fund's name from this column instead: the
-- couple's record says what the guest gave to, whatever happens to the listing
-- afterwards. NULL for a gift to no fund.
--
-- The UPDATE copies the current title onto every gift that still names a
-- listing. A gift whose listing is already gone stays NULL. No other column
-- changes.

ALTER TABLE `registry_contributions` ADD `item_title` text;
--> statement-breakpoint
UPDATE `registry_contributions`
SET `item_title` = (
  SELECT `title` FROM `registry_items` WHERE `registry_items`.`id` = `registry_contributions`.`item_id`
)
WHERE `item_id` IS NOT NULL;
