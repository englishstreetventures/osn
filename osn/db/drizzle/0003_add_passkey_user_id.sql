ALTER TABLE `accounts` ADD COLUMN `passkey_user_id` text NOT NULL DEFAULT '';--> statement-breakpoint
UPDATE `accounts` SET `passkey_user_id` = lower(hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' || substr(hex(randomblob(2)),2) || '-a' || substr(hex(randomblob(2)),2) || '-' || hex(randomblob(6))) WHERE `passkey_user_id` = '';--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_passkey_user_id_unique` ON `accounts` (`passkey_user_id`);
