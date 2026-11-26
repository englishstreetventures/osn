-- A session's restriction record is one osn-api knows, and only on a
-- restricted row. `restricted_amr` is NULL, or it is 'webauthn', 'otp', 'totp'
-- or 'signup' on a row whose `restricted_until` is set. Two triggers refuse
-- any other value on insert and on an update of either column. A CHECK would
-- need a copy-and-swap rebuild of `sessions`, and D1 enforces foreign keys, so
-- dropping the old table would cascade into every table that points at it.
-- The triggers move no rows.
--
-- A row with `restricted_until` set and `restricted_amr` NULL stays allowed:
-- restricted rows written before migration 0009 recorded no factor, and every
-- reader of the record treats an absent one as granting nothing.
--
-- Every writer passes. Issuing a session writes NULL, or a recovery's factor
-- ('webauthn', 'otp' or 'totp') or 'signup' beside its deadline; rotation
-- copies both columns from the row it replaces; the lift on a first passkey
-- clears both. The osn-api released with this file also writes 'signup'; the
-- one before it writes only NULL, 'webauthn', 'otp' and 'totp', so both pass.
--
-- This file changes no stored row, so it cannot fail on what a database
-- already holds; the triggers judge only a new row or a new value. The
-- refusal's fixed message names no row and no value.
--
-- Every statement runs again safely: each trigger is created only if absent.
CREATE TRIGGER IF NOT EXISTS `sessions_restriction_known` BEFORE INSERT ON `sessions`
WHEN NEW.`restricted_amr` IS NOT NULL
  AND (NEW.`restricted_until` IS NULL OR NEW.`restricted_amr` NOT IN ('webauthn', 'otp', 'totp', 'signup'))
BEGIN
	SELECT RAISE(ABORT, 'session restriction record is not known or has no deadline');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `sessions_restriction_known_update` BEFORE UPDATE OF `restricted_until`, `restricted_amr` ON `sessions`
WHEN NEW.`restricted_amr` IS NOT NULL
  AND (NEW.`restricted_until` IS NULL OR NEW.`restricted_amr` NOT IN ('webauthn', 'otp', 'totp', 'signup'))
BEGIN
	SELECT RAISE(ABORT, 'session restriction record is not known or has no deadline');
END;
