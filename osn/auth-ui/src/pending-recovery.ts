/**
 * The email-recovery wait a tab keeps in `sessionStorage`, with no component
 * imports, so a page can ask whether a recovery is pending without loading
 * `SignIn` or `RecoveryLoginForm`.
 */

import type { EmailRecoveryRequest } from "@osn/client";

/**
 * The email recovery this tab waits on: the request, and the address the
 * waiting view names. Not its number, which is never stored: the view holds it
 * in memory, and a reloaded tab gets it back from its first poll.
 */
export interface Waiting extends Omit<EmailRecoveryRequest, "pairingCode"> {
  readonly email: string;
}

/** Per tab, never sent anywhere, never shared with another site. */
export const PENDING_KEY = "osn.recovery.pending";

export function writeStoredWait(value: Waiting | null): void {
  try {
    if (value === null) sessionStorage.removeItem(PENDING_KEY);
    else sessionStorage.setItem(PENDING_KEY, JSON.stringify(value));
  } catch {
    // Storage disabled or full: the wait lives in memory for this page.
  }
}

/** The stored wait, when it is whole and has not expired; clears one that has. */
export function storedWait(): Waiting | null {
  let stored: Partial<Waiting> | null = null;
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    stored = raw === null ? null : (JSON.parse(raw) as Partial<Waiting>);
  } catch {
    stored = null;
  }
  if (
    !stored ||
    typeof stored.requestId !== "string" ||
    typeof stored.claimSecret !== "string" ||
    typeof stored.email !== "string" ||
    typeof stored.expiresAt !== "number" ||
    stored.expiresAt * 1000 <= Date.now()
  ) {
    if (stored) writeStoredWait(null);
    return null;
  }
  return {
    requestId: stored.requestId,
    claimSecret: stored.claimSecret,
    email: stored.email,
    expiresAt: stored.expiresAt,
  };
}

/**
 * Whether this tab is waiting on an emailed recovery link, so a host can open
 * its sign-in on the recovery view after a reload and let it resume.
 */
export function hasPendingRecovery(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  return storedWait() !== null;
}
