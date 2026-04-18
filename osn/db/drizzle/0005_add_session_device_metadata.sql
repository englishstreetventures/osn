-- Session device metadata (session listing + per-device revoke).
--
-- Adds five columns to the sessions table so the user-facing session list
-- can display where each session is active and flag the current device:
--   user_agent        : raw UA header (UI parses for display)
--   ip_hash           : SHA-256(clientIp + OSN_IP_HASH_SALT) — coarse fingerprint
--   device_label      : user-set nickname (null until renamed)
--   last_seen_at      : unix seconds, bumped on every verifyRefreshToken
--   created_ip_hash   : ip_hash pinned at session-create time
--
-- Breaking change: `last_seen_at` is NOT NULL with DEFAULT unixepoch(). Existing
-- rows receive the default, but new deploys should treat this as a one-time
-- wipe point for any rows inserted before this migration — the device
-- columns on pre-existing rows will be null, which the session list renders
-- as "unknown device".
ALTER TABLE `sessions` ADD `user_agent` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `ip_hash` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `device_label` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_seen_at` integer NOT NULL DEFAULT (unixepoch());--> statement-breakpoint
ALTER TABLE `sessions` ADD `created_ip_hash` text;--> statement-breakpoint
CREATE INDEX `sessions_last_seen_idx` ON `sessions` (`last_seen_at`);
