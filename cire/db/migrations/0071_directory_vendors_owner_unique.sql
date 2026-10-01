-- An OSN organisation owns at most one directory listing. The unique index
-- replaces the plain one on the same column; SQLite lets any number of rows
-- hold NULL, so unclaimed listings are unaffected.
--
-- CREATE runs before DROP so a failure leaves the old index in place. It fails
-- if two listings already share an owner: find them first with
--   SELECT owner_org_id, COUNT(*) FROM directory_vendors
--   WHERE owner_org_id IS NOT NULL GROUP BY owner_org_id HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX `directory_vendors_owner_uniq` ON `directory_vendors` (`owner_org_id`);--> statement-breakpoint
DROP INDEX `directory_vendors_owner_idx`;
