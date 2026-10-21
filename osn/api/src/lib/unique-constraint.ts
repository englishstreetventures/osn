/**
 * Shared narrowing for "was this write failure a uniqueness conflict?".
 *
 * Test it against `driverErrorText(e)` (`@shared/db-utils`), never against
 * `e.message`. A failed D1 `db.batch(...)` carries the SQLite text at the top
 * level, but a failed single statement, on D1 or on bun:sqlite (including
 * `commitBatch`'s sequential fallback), arrives as drizzle's
 * `DrizzleQueryError`, whose message names only the statement and whose
 * `cause` carries the reason.
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
