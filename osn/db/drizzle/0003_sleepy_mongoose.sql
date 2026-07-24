ALTER TABLE `oauth_clients` ADD `owner_account_id` text REFERENCES accounts(id);--> statement-breakpoint
CREATE INDEX `oauth_clients_owner_idx` ON `oauth_clients` (`owner_account_id`);