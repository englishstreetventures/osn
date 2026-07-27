-- Organiser sessions, minted by the OSN OIDC login flow.
--
-- Why cire needs its own session at all: identity moved to `musubi.social`
-- (2026-07-27), so the WebAuthn RP ID is `musubi.social` and the cireweddings
-- origins can no longer run a passkey ceremony. Organisers now sign in by
-- redirect — `api.cireweddings.com/api/auth/oidc/start` → the OSN authorize
-- endpoint → back to `/api/auth/oidc/callback`. The old model (hold an OSN
-- access token in memory and silent-refresh it) is dead with it: `authFetch`
-- refreshed against OSN's HttpOnly session cookie, which is now cross-site to
-- cireweddings.com and never sent.
--
-- Same shape as the guest `sessions` table and for the same reasons: an opaque
-- random token, SHA-256 hashed at rest so a database read cannot mint a
-- session, in a host-scoped HttpOnly cookie on `api.cireweddings.com`.
--
-- `osn_profile_id` is the real `usr_*` id, carried by the first-party-only
-- `osn_profile_id` ID-token claim. It has to be the profile id, not the OIDC
-- pairwise `sub`: every authorisation row cire already holds
-- (`weddings.owner_osn_profile_id`, `wedding_hosts.osn_profile_id`) and all
-- three ARC bridges to the OSN graph are keyed on profile ids, so a pairwise
-- subject would orphan every existing row. `osn_sub` keeps the pairwise subject
-- alongside it for audit and for matching a revoked OIDC connection.
--
-- `email`/`handle`/`display_name`/`avatar_url` are a login-time snapshot of the
-- ID token's profile claims, not a profile record. The portal chrome needs a
-- name to render and can no longer read it from an OSN session, and cire cannot
-- call the OSN profile endpoint on the user's behalf cross-site. They expire
-- with the row and are re-taken on every sign-in; nothing else reads them.
--
-- No foreign key: OSN identities live in a different D1 database.
--
-- Deliberately its own table rather than a nullable column set on `sessions` —
-- the guest table cascades from `families`, which an organiser has no row in.
CREATE TABLE `organiser_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`osn_profile_id` text NOT NULL,
	`osn_sub` text NOT NULL,
	`email` text,
	`handle` text,
	`display_name` text,
	`avatar_url` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organiser_sessions_token_unique` ON `organiser_sessions` (`token`);--> statement-breakpoint
-- Sign-out-everywhere and the account-erasure sweep both delete by profile id.
CREATE INDEX `organiser_sessions_profile_idx` ON `organiser_sessions` (`osn_profile_id`);--> statement-breakpoint
-- The nightly cron deletes every row past its expiry.
CREATE INDEX `organiser_sessions_expires_idx` ON `organiser_sessions` (`expires_at`);
