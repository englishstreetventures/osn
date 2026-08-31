/**
 * Shared narrowing for "was this write failure a uniqueness conflict?".
 *
 * Both `completeRegistration` and `completeEmailChange` write through
 * `commitBatch` (`@shared/db-utils`), and neither driver path wraps the
 * failure: D1's `db.batch(...)` and bun:sqlite's sequential fallback both
 * leave the raw SQLite text in `e.message` at the top level, so no `.cause`
 * walk is needed or wanted here.
 *
 * Only a uniqueness violation is a genuine caller-facing conflict (another
 * account already claimed the address/handle). NOT NULL / FOREIGN KEY /
 * CHECK constraint failures are DB faults, not user races — they must
 * surface as DatabaseError, never get mapped to a benign "someone else got
 * there first" outcome.
 *
 * Both spellings are accepted because the two drivers do not agree:
 * bun:sqlite raises `UNIQUE constraint failed: accounts.email`, and a driver
 * that reports the SQLite result code instead would carry
 * `SQLITE_CONSTRAINT_UNIQUE`. Neither spelling can match a NOT NULL, FOREIGN
 * KEY or CHECK failure, so the narrowing holds.
 */
export const UNIQUE_CONSTRAINT_ERROR = /UNIQUE constraint|SQLITE_CONSTRAINT_UNIQUE/i;
