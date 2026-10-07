-- Indexes on four foreign-key child columns that `ON DELETE cascade` searches:
-- registry_claims.family_id and registry_contributions.family_id (from
-- families), vendor_enquiries.vendor_id (from vendors) and
-- guest_account_links.wedding_id (from weddings). Without them, deleting a
-- household, a CRM vendor or a wedding scans each child table across every
-- wedding. Additive: no rebuild, no data change.

CREATE INDEX `guest_account_links_wedding_idx` ON `guest_account_links` (`wedding_id`);--> statement-breakpoint
CREATE INDEX `registry_claims_family_idx` ON `registry_claims` (`family_id`);--> statement-breakpoint
CREATE INDEX `registry_contributions_family_idx` ON `registry_contributions` (`family_id`);--> statement-breakpoint
CREATE INDEX `vendor_enquiries_vendor_idx` ON `vendor_enquiries` (`vendor_id`);