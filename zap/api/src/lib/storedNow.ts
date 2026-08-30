/**
 * `new Date()` truncated to the second.
 *
 * Drizzle's `integer(..., { mode: "timestamp" })` stores whole seconds, so a
 * `Date` carrying milliseconds is not what comes back out. That never showed
 * while every write re-read its own row; the moment a service returns the
 * values it just inserted, an untruncated `Date` makes the write's response
 * disagree with every later read of the same row by up to 999ms — enough to
 * put a `createdAt` cursor on the wrong side of its own message.
 *
 * Use this for any timestamp that is both written to the database and handed
 * back to a caller.
 */
export const storedNow = (): Date => new Date(Math.floor(Date.now() / 1000) * 1000);
