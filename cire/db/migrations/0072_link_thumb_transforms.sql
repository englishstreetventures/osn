-- One row per calendar month (UTC): how many Images-binding transforms the
-- registry link picker's thumbnails have spent, across every wedding. The
-- thumbnail route stops at a fixed share of the account's Images quota, which
-- the invite images guests load spend from too. No wedding or profile id.

CREATE TABLE `link_thumb_transforms` (
	`period` text PRIMARY KEY NOT NULL,
	`used` integer DEFAULT 0 NOT NULL
);
