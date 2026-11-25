CREATE TABLE `change_notice_runs` (
	`notice_id` text PRIMARY KEY NOT NULL,
	`started_at` integer NOT NULL,
	`cursor` text,
	`sent` integer DEFAULT 0 NOT NULL,
	`failed` integer DEFAULT 0 NOT NULL,
	`finished_at` integer,
	`pending_key` text,
	`pending_last` text,
	`pending_count` integer,
	`pending_since` integer,
	`pending_attempts` integer,
	`pending_refused` integer,
	`pending_state` text,
	CONSTRAINT "change_notice_runs_pending_ck" CHECK((pending_key IS NULL AND pending_last IS NULL AND pending_count IS NULL AND pending_since IS NULL AND pending_attempts IS NULL AND pending_refused IS NULL AND pending_state IS NULL) OR (pending_key IS NOT NULL AND pending_last IS NOT NULL AND pending_count IS NOT NULL AND pending_since IS NOT NULL AND pending_attempts IS NOT NULL AND pending_refused IS NOT NULL AND pending_state IS NOT NULL)),
	CONSTRAINT "change_notice_runs_state_ck" CHECK(pending_state IS NULL OR pending_state IN ('open', 'unconfirmed')),
	CONSTRAINT "change_notice_runs_attempts_ck" CHECK(pending_refused IS NULL OR (pending_refused >= 0 AND pending_refused <= pending_attempts)),
	CONSTRAINT "change_notice_runs_finished_ck" CHECK(finished_at IS NULL OR (cursor IS NULL AND pending_key IS NULL))
);
