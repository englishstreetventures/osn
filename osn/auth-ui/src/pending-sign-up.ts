/**
 * The sign-up wait a tab keeps in `sessionStorage`, with no component imports,
 * so a page can ask whether a sign-up is pending without loading `Register`.
 */

import type { BegunRegistration } from "@osn/client";

/**
 * A sign-up this tab is waiting on: the request, and the address and handle
 * the view names. Not its number, which is never stored: the view holds it in
 * memory, and a reloaded tab gets it back from its first poll.
 */
export interface Waiting extends Omit<BegunRegistration, "pairingCode"> {
  readonly email: string;
  readonly handle: string;
}

/**
 * The sign-up this tab waits on, kept in `sessionStorage` so a reload — or a
 * phone discarding the tab while the person reads their mail — resumes the
 * wait rather than losing it. Per tab, never sent anywhere, never shared with
 * another site. No birthdate and no pairing number are kept.
 */
export const PENDING_KEY = "osn.signup.pending";
/**
 * A sign-up this tab began and left (Cancel, a different email). The next
 * begin sends it as `previous`, which retires it, so the address is not held
 * by a request nobody waits on.
 */
export const PREVIOUS_KEY = "osn.signup.previous";

export function readStored<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(key);
    return raw === null ? null : (JSON.parse(raw) as T);
  } catch {
    return null;
  }
}

export function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage disabled or full: the wait lives in memory for this page.
  }
}

/** The stored wait, when it is whole and has not expired; clears one that has. */
export function storedWaiting(): Waiting | null {
  const stored = readStored<Partial<Waiting>>(PENDING_KEY);
  if (
    !stored ||
    typeof stored.requestId !== "string" ||
    typeof stored.claimSecret !== "string" ||
    typeof stored.email !== "string" ||
    typeof stored.handle !== "string" ||
    typeof stored.expiresAt !== "number"
  ) {
    if (stored) writeStored(PENDING_KEY, null);
    return null;
  }
  if (stored.expiresAt * 1000 <= Date.now()) {
    writeStored(PENDING_KEY, null);
    return null;
  }
  return {
    requestId: stored.requestId,
    claimSecret: stored.claimSecret,
    email: stored.email,
    handle: stored.handle,
    expiresAt: stored.expiresAt,
  };
}

/**
 * Whether this tab is waiting on a sign-up link, so a host can reopen
 * `<Register>` after a reload and let it resume.
 */
export function hasPendingSignUp(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  return storedWaiting() !== null;
}
