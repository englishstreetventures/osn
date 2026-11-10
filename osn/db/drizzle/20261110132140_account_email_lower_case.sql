-- An account's email is stored in lower case. Two triggers refuse an email
-- holding a capital letter, on insert and on an update of `email`. A CHECK
-- would need a copy-and-swap rebuild of `accounts`, and D1 enforces foreign
-- keys, so dropping the old table would cascade into every table that points
-- at it. The triggers move no rows.
--
-- This file changes no stored row, so it cannot fail on what a database
-- already holds, and the Worker it replaces reads the same data afterwards. A
-- row stored before it keeps its email exactly as stored: the triggers judge
-- only a new insert or a new value. Sign-in and recovery match an address both
-- as typed and lower-cased, preferring the row stored as typed, so such a row
-- still signs in by its address exactly as stored.
--
-- SQLite's lower() folds the letters A to Z. Every writer stores an address
-- that holds none of them (JavaScript's toLowerCase() of what was typed, or a
-- lower-case literal), so every writer passes. The refusal's fixed message
-- names no row and no value.
--
-- Every statement runs again safely: each trigger is created only if absent.
CREATE TRIGGER IF NOT EXISTS `accounts_email_lower_case` BEFORE INSERT ON `accounts`
WHEN NEW.`email` <> lower(NEW.`email`)
BEGIN
	SELECT RAISE(ABORT, 'account email is not lower case');
END;--> statement-breakpoint
CREATE TRIGGER IF NOT EXISTS `accounts_email_lower_case_update` BEFORE UPDATE OF `email` ON `accounts`
WHEN NEW.`email` <> lower(NEW.`email`)
BEGIN
	SELECT RAISE(ABORT, 'account email is not lower case');
END;
