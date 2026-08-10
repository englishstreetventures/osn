-- Browser sessions for the Pulse web app, minted by the OSN OIDC login flow.
--
-- Why Pulse needs its own session at all: the iOS app holds an OSN refresh
-- token and presents a bearer access JWT on every call, and `extractClaims`
-- verifies it. A browser cannot do that. The OSN issuer lives on
-- `musubi.social`, a different site from Pulse web, so OSN's HttpOnly session
-- cookie is never sent to the Pulse API and there is nothing to silent-refresh
-- against. Pulse web signs in by redirect instead — `/api/auth/oidc/start` →
-- the OSN authorize endpoint → back to `/api/auth/oidc/callback` — and the API
-- mints this row and sets its own host-scoped cookie.
--
-- Same shape and reasoning as cire's `organiser_sessions` (cire migration
-- 0047): an opaque random token, SHA-256 hashed at rest so a database read
-- cannot mint a session, carried in a host-scoped HttpOnly cookie.
--
-- `osn_profile_id` is the real `usr_*` id from the first-party-only
-- `osn_profile_id` ID-token claim, not the OIDC pairwise `sub`. It has to be:
-- every Pulse row keys on the profile id (`events.organiser_profile_id`,
-- `event_rsvps.profile_id`, `pulse_users.profile_id`), and the access JWT the
-- iOS clients present resolves to the same value — the two callers must land on
-- one identifier or a user's web session would see none of their own data.
-- `osn_sub` keeps the pairwise subject for audit and for matching a revoked
-- OIDC connection.
--
-- `email`/`handle`/`display_name`/`avatar_url` are a login-time snapshot of the
-- ID token's profile claims, not a profile record. The web chrome needs a name
-- to render and cannot read one from an OSN session cross-site. They expire
-- with the row and are re-taken on every sign-in.
--
-- No foreign key: OSN identities live in a different D1 database.
CREATE TABLE `pulse_web_sessions` (
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
CREATE UNIQUE INDEX `pulse_web_sessions_token_unique` ON `pulse_web_sessions` (`token`);--> statement-breakpoint
-- Sign-out-everywhere, the OIDC connection-revocation hook and account erasure
-- all delete by profile id.
CREATE INDEX `pulse_web_sessions_profile_idx` ON `pulse_web_sessions` (`osn_profile_id`);--> statement-breakpoint
-- The sweep deletes every row past its expiry.
CREATE INDEX `pulse_web_sessions_expires_idx` ON `pulse_web_sessions` (`expires_at`);
