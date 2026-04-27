-- C-H1 / C-M1: DSAR audit log.
--
-- One row per Data Subject Access / Verifiable Consumer Request — created
-- when the request opens and updated when it closes. Backs the
-- `GET /account/export` endpoint's prior-DSAR section and the 30/45-day
-- response-SLA dashboards.
--
-- `regime`, `right`, `decision` are bounded enums enforced at the service
-- layer (matching the `security_events.kind` pattern) so a new value does
-- not require a fresh migration.
--
-- Retention: 24 months from `closed_at` (CCPA §999.317) — enforced by a
-- future C-M2 sweeper. Volume expected ≤1 row per account per year.
--
-- Index choices:
--   • dsar_requests_account_idx — drives the prior-DSAR list inside the
--     account holder's own export.
--   • dsar_requests_opened_at_idx — drives the in-flight check (refuse
--     a second request while one is still open) and the retention sweep.

CREATE TABLE `dsar_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`regime` text NOT NULL,
	`right` text NOT NULL,
	`opened_at` integer NOT NULL,
	`closed_at` integer,
	`decision` text,
	`exemption` text,
	`evidence_path` text,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);--> statement-breakpoint
CREATE INDEX `dsar_requests_account_idx` ON `dsar_requests` (`account_id`);--> statement-breakpoint
CREATE INDEX `dsar_requests_opened_at_idx` ON `dsar_requests` (`opened_at`);
