-- The owner-notice email budget: notice emails sent per key per UTC day,
-- where a key is a wedding or the owner who acted. Shared across Worker
-- isolates, so the daily cap holds for the whole Worker. New table, no FK:
-- additive, no rebuild, no data change.

CREATE TABLE `owner_notice_budget` (
	`key` text NOT NULL,
	`day` text NOT NULL,
	`sent` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`key`, `day`)
);
