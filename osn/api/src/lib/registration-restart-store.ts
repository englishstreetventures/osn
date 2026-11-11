/**
 * Per-mailbox bound on the sign-up links a restart mails.
 *
 * A begin's first sign-up link never counts against the Resend cap, so the
 * newest sign-up always gets its link. That leaves a loop open to whoever
 * holds a request's claim secret: begin, free the address, begin again. Two
 * ways free it at once: `previous` on the next begin, and the reader's
 * decline. So a first link counts here, against `REGISTRATION_RESTART_LINKS_MAX`
 * an hour per mailbox, when its begin carried `previous`, or when a sign-up
 * to the mailbox was declined in the hour before. A first begin with neither
 * is not counted, and a mailbox whose window is fresh always admits the first
 * counted link.
 *
 * Two keys per mailbox, both the caller's keyed digest of `mailboxKey(address)`
 * (every `+tag` and Gmail form of one mailbox shares them):
 *
 *  - `declined.<key>`: written on each decline, kept one window from the
 *    latest, so "declined within the hour" always means the hour before now;
 *  - `links.<key>`: the counted links, in a fixed window from the first.
 *
 * Fails closed: a marker that cannot be read counts the link, and a count
 * that cannot be made sends nothing.
 */

import {
  REGISTRATION_RESTART_LINKS_MAX,
  REGISTRATION_RESTART_WINDOW_MS,
} from "../services/auth/constants";

export interface RegistrationRestartStore {
  readonly backend: "memory" | "durable_object";
  /** Records a decline of a sign-up to `key`'s mailbox, for one window from now. Never rejects. */
  markDeclined(key: string): Promise<void>;
  /** Whether a sign-up to `key`'s mailbox was declined in the last window; `"unknown"` when unreadable. */
  declinedLately(key: string): Promise<boolean | "unknown">;
  /**
   * Counts one restart link to `key`'s mailbox. True while the window holds
   * no more than its allowance; false past it, or when the count could not
   * be made.
   */
  admitLink(key: string): Promise<boolean>;
}

/** The two object keys one mailbox uses. */
export const restartKeys = (key: string) => ({
  declined: `declined.${key}`,
  links: `links.${key}`,
});

/** In-memory store — single-process dev and tests. It cannot fail. */
export function createInMemoryRegistrationRestartStore(
  max = REGISTRATION_RESTART_LINKS_MAX,
  windowMs = REGISTRATION_RESTART_WINDOW_MS,
): RegistrationRestartStore {
  const declinedUntil = new Map<string, number>();
  const counts = new Map<string, { n: number; resetAt: number }>();
  return {
    backend: "memory",
    async markDeclined(key) {
      declinedUntil.set(key, Date.now() + windowMs);
    },
    async declinedLately(key) {
      const until = declinedUntil.get(key);
      if (until === undefined) return false;
      if (Date.now() >= until) {
        declinedUntil.delete(key);
        return false;
      }
      return true;
    },
    async admitLink(key) {
      const now = Date.now();
      const bucket = counts.get(key);
      if (!bucket || now >= bucket.resetAt) {
        counts.set(key, { n: 1, resetAt: now + windowMs });
        return true;
      }
      bucket.n += 1;
      return bucket.n <= max;
    },
  };
}
