-- At most one default profile per account, held by a partial unique index.
--
-- The index cannot be built over an account that already has two defaults,
-- so the two statements before it settle every account first, without anyone
-- reading the rows: where an account has several defaults, all but its
-- oldest (by `created_at`, then `id`) stop being the default; where it has
-- none, its oldest profile becomes the default. An account with exactly one
-- default is untouched. The token grant mints for the account's default
-- profile, so each account keeps one to sign in as.
--
-- The Worker this release replaces sets a default only by clearing the old
-- one in the same batch, or on a new account's only profile. Its dev-tier
-- sign-in alone would meet the index, by putting its fixed profile back as
-- the default beside another; this release makes that insert plain where the
-- account already has a default.
UPDATE `users` SET `is_default` = 0
WHERE `is_default` = 1
	AND `id` <> (
		SELECT `kept`.`id` FROM `users` AS `kept`
		WHERE `kept`.`account_id` = `users`.`account_id` AND `kept`.`is_default` = 1
		ORDER BY `kept`.`created_at`, `kept`.`id`
		LIMIT 1
	);--> statement-breakpoint
UPDATE `users` SET `is_default` = 1
WHERE `id` = (
		SELECT `oldest`.`id` FROM `users` AS `oldest`
		WHERE `oldest`.`account_id` = `users`.`account_id`
		ORDER BY `oldest`.`created_at`, `oldest`.`id`
		LIMIT 1
	)
	AND NOT EXISTS (
		SELECT 1 FROM `users` AS `current`
		WHERE `current`.`account_id` = `users`.`account_id` AND `current`.`is_default` = 1
	);--> statement-breakpoint
CREATE UNIQUE INDEX `users_one_default_per_account` ON `users` (`account_id`) WHERE "users"."is_default" = 1;
