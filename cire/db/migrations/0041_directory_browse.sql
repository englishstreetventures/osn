-- 0041_directory_browse.sql — Vendors S3 directory browse (additive; index-only, no drops).
-- Dedup guard: at most one CRM row per (wedding, directory listing). Manual rows
-- (directory_vendor_id IS NULL) are unaffected — a wedding may hold many.
CREATE UNIQUE INDEX `vendors_wedding_directory_uniq`
  ON `vendors` (`wedding_id`, `directory_vendor_id`)
  WHERE `directory_vendor_id` IS NOT NULL;
--> statement-breakpoint
-- Browse filters directory_vendors on `listed`.
CREATE INDEX `directory_vendors_listed_idx` ON `directory_vendors` (`listed`);
