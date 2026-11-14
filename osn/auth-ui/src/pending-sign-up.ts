/**
 * The sign-up wait a tab keeps in `sessionStorage`, and the live request the
 * browser shares across its tabs in `localStorage`, with no component imports,
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

/**
 * The newest live sign-up this browser began, kept in `localStorage` so a new
 * tab or window of the same browser can retire it — `previous` on its begin,
 * when the address typed is this one — and have its own link mailed at once,
 * rather than wait up to ten minutes for the request that holds the address to
 * expire. It holds the request id, the claim secret, the expiry and the address
 * as begin keys it (lowercased); never the number, the handle or the
 * birthdate. The claim secret confers nothing without the emailed link and the
 * number on the waiting screen.
 *
 * Written only by the tab whose begin made the request, never on a resumed
 * wait, so no tab brings back an entry another tab removed. Removed, only
 * while it still names the request in hand, when the account is made, when
 * the request is gone, and by the begin that retires it; a "Start again" keeps
 * it, since the request holds the address until a begin retires it. One that
 * has expired is removed by the next read, so it outlives its request only
 * until the next visit, and holds no session. Tabs send it nothing else: a tab
 * whose request another tab retired learns so from its next poll.
 */
export const SHARED_KEY = "osn.signup.live";

export interface SharedSignUp {
  readonly requestId: string;
  readonly claimSecret: string;
  /** Seconds since the epoch, as begin answers it. */
  readonly expiresAt: number;
  /** The address as begin keys it: lowercased. */
  readonly email: string;
}

/** The shared sign-up, when it is whole and live; removes one that is not. */
export function sharedSignUp(): SharedSignUp | null {
  try {
    const raw = localStorage.getItem(SHARED_KEY);
    if (raw === null) return null;
    const stored = JSON.parse(raw) as Partial<SharedSignUp> | null;
    if (
      !stored ||
      typeof stored.requestId !== "string" ||
      typeof stored.claimSecret !== "string" ||
      typeof stored.email !== "string" ||
      typeof stored.expiresAt !== "number" ||
      stored.expiresAt * 1000 <= Date.now()
    ) {
      localStorage.removeItem(SHARED_KEY);
      return null;
    }
    return {
      requestId: stored.requestId,
      claimSecret: stored.claimSecret,
      expiresAt: stored.expiresAt,
      email: stored.email,
    };
  } catch {
    // Storage disabled, or the entry unreadable: there is nothing to share.
    return null;
  }
}

/** Shares the request this tab's begin just made, replacing any older one. */
export function shareSignUp(entry: SharedSignUp): void {
  try {
    localStorage.setItem(SHARED_KEY, JSON.stringify(entry));
  } catch {
    // Storage disabled or full: other tabs wait out the request, as before.
  }
}

/** Removes the shared sign-up, only while it is still `requestId`. */
export function unshareSignUp(requestId: string): void {
  try {
    const raw = localStorage.getItem(SHARED_KEY);
    if (raw === null) return;
    const stored = JSON.parse(raw) as Partial<SharedSignUp> | null;
    if (stored?.requestId === requestId) localStorage.removeItem(SHARED_KEY);
  } catch {
    // Storage disabled, or the entry unreadable: the next read removes it.
  }
}

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
 * `<Register>` after a reload and let it resume. Hosts ask on every load, so
 * it also removes a shared sign-up that has expired.
 */
export function hasPendingSignUp(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  sharedSignUp();
  return storedWaiting() !== null;
}
