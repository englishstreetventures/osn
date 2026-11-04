-- `vendors.status` is a pipeline stage. A CHECK cannot be added to an existing
-- SQLite table without a copy-and-swap, which would cascade into
-- `vendor_enquiries`, so two triggers refuse any other value instead.
CREATE TRIGGER `vendors_status_stage` BEFORE INSERT ON `vendors`
WHEN NEW.`status` NOT IN ('researching', 'contacted', 'quoted', 'booked', 'declined')
BEGIN
	SELECT RAISE(ABORT, 'vendor status is not a pipeline stage');
END;--> statement-breakpoint
CREATE TRIGGER `vendors_status_stage_update` BEFORE UPDATE OF `status` ON `vendors`
WHEN NEW.`status` NOT IN ('researching', 'contacted', 'quoted', 'booked', 'declined')
BEGIN
	SELECT RAISE(ABORT, 'vendor status is not a pipeline stage');
END;
