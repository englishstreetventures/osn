/**
 * The sign-up wait a tab keeps in `sessionStorage`, and the one entry every
 * tab of the browser shares in `localStorage`, with no component imports, so
 * a page can ask whether a sign-up is pending without loading `Register`.
 */

import type { BegunRegistration, PreviousRegistration } from "@osn/client";

/**
 * A sign-up this tab is waiting on: the request, and the address and handle
 * the view names. Not its number, which is never stored: the view holds it in
 * memory, and a reloaded tab gets it back from its first poll. A wait with no
 * retire secret still polls and resends; leaving it keeps nothing to retire.
 */
export interface Waiting extends Omit<BegunRegistration, "pairingCode" | "retireSecret"> {
  readonly retireSecret?: string;
  readonly email: string;
  readonly handle: string;
}

/**
 * The sign-up this tab waits on, kept in `sessionStorage` so a reload — or a
 * phone discarding the tab while the person reads their mail — resumes the
 * wait rather than losing it. Per tab, never sent anywhere, never shared with
 * another site. No birthdate and no pairing number are kept here; the
 * birthdate the person typed is the draft's (`DRAFT_KEY`).
 */
export const PENDING_KEY = "osn.signup.pending";
/**
 * A sign-up this tab began and left (Cancel, a different email): its request,
 * retire secret and the address it was for. The next begin for that address
 * sends it as `previous`, which retires it, so the address is not held by a
 * request nobody waits on. Per tab, like the wait it was.
 */
export const PREVIOUS_KEY = "osn.signup.previous";
/**
 * The live sign-up of this browser, in `localStorage` so every tab reads it:
 * the request, its retire secret and its expiry. Nothing about the address,
 * and never the claim secret, a token or the number. A tab that begins sends
 * it as `previous`; osn-api retires the earlier request only when the new
 * begin is for its address, so the new link goes at once.
 */
export const LIVE_KEY = "osn.signup.live";
/**
 * What the person typed on the details step, kept in `sessionStorage` so
 * closing the dialog (Cancel, Escape, a press outside) or reloading the tab
 * loses none of it: the address, the handle, the display name, and the date of
 * birth only once it is a date in range that clears the 13+ gate — a date that
 * would be refused is never written. Never a secret, a token or the number.
 * Per tab, never sent anywhere; removed once the account is made.
 */
export const DRAFT_KEY = "osn.signup.draft";
/**
 * A new account whose first passkey is still to be added, in `localStorage`:
 * its profile id, the handle the server made it under, and when the session
 * the sign-up holds for it ends (milliseconds). No token: the restricted
 * session is the browser's HttpOnly cookie, which every tab shares, so this
 * is the browser's too, and the view asks the cookie for a token when the
 * person presses "Add a passkey" (and checks the token is this account's).
 * Kept so a reload, a closed dialog or a closed tab reopens on the passkey
 * step rather than at a details form whose address already has an account.
 * Removed once the passkey is in, once the session behind it has ended, or
 * once the cookie answers for anyone else.
 */
export const ENROLLING_KEY = "osn.signup.enrolling";

/** The fields of the details step, as `DRAFT_KEY` keeps them. */
export interface SignUpDraft {
  readonly email: string;
  readonly handle: string;
  readonly birthdate: string;
  readonly displayName: string;
}

const EMPTY_DRAFT: SignUpDraft = { email: "", handle: "", birthdate: "", displayName: "" };

/** A new account still to get its first passkey, as `ENROLLING_KEY` keeps it. */
export interface Enrolling {
  readonly profileId: string;
  readonly handle: string;
  /** When the sign-up's session ends, in milliseconds. */
  readonly expiresAt: number;
}

/** The shared entry. `expiresAt` is Unix seconds, as begin answers it. */
export interface LiveSignUp {
  readonly requestId: string;
  readonly retireSecret: string;
  readonly expiresAt: number;
}

const REQUEST_ID = /^signup_[a-f0-9]{12}$/;
const HEX_64 = /^[a-f0-9]{64}$/;

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
  const waiting: Waiting = {
    requestId: stored.requestId,
    claimSecret: stored.claimSecret,
    email: stored.email,
    handle: stored.handle,
    expiresAt: stored.expiresAt,
  };
  if (typeof stored.retireSecret !== "string" || !HEX_64.test(stored.retireSecret)) return waiting;
  return { ...waiting, retireSecret: stored.retireSecret };
}

/** `{ requestId, retireSecret }` when both have the shape begin takes, else null. */
function asPrevious(value: Partial<PreviousRegistration> | null): PreviousRegistration | null {
  if (typeof value !== "object" || value === null) return null;
  const { requestId, retireSecret } = value;
  if (typeof requestId !== "string" || !REQUEST_ID.test(requestId)) return null;
  if (typeof retireSecret !== "string" || !HEX_64.test(retireSecret)) return null;
  return { requestId, retireSecret };
}

/** The request this tab left, and the address it was for when that is known. */
export interface LeftRequest {
  readonly previous: PreviousRegistration;
  readonly email: string | null;
}

/** The request this tab left, when it has the shape begin takes; anything else is removed. */
export function storedPrevious(): LeftRequest | null {
  const stored = readStored<Partial<PreviousRegistration & { email: string }>>(PREVIOUS_KEY);
  const previous = asPrevious(stored);
  if (stored !== null && !previous) writeStored(PREVIOUS_KEY, null);
  if (!previous) return null;
  return { previous, email: typeof stored?.email === "string" ? stored.email : null };
}

/** Keeps `request` as the one this tab's next begin retires; nothing without its retire secret. */
export function keepPrevious(request: {
  requestId: string;
  retireSecret?: string;
  email: string;
}): void {
  const previous = asPrevious(request);
  if (previous) writeStored(PREVIOUS_KEY, { ...previous, email: request.email });
}

/** Forgets the request this tab left, when it is `requestId`. */
export function forgetPrevious(requestId: string): void {
  if (readStored<Partial<PreviousRegistration>>(PREVIOUS_KEY)?.requestId === requestId) {
    writeStored(PREVIOUS_KEY, null);
  }
}

function removeLive(): void {
  try {
    localStorage.removeItem(LIVE_KEY);
  } catch {
    // Storage disabled: there is no entry to remove.
  }
}

/**
 * The shared entry when it is whole and its request has not expired. One that
 * is malformed or has expired is removed and answers null.
 */
export function readLive(): LiveSignUp | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(LIVE_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let parsed: Partial<LiveSignUp> | null;
  try {
    parsed = JSON.parse(raw) as Partial<LiveSignUp> | null;
  } catch {
    parsed = null;
  }
  const previous = asPrevious(parsed);
  const expiresAt = parsed?.expiresAt;
  if (!previous || typeof expiresAt !== "number" || expiresAt * 1000 <= Date.now()) {
    removeLive();
    return null;
  }
  return { ...previous, expiresAt };
}

/**
 * Writes the shared entry, field by field so nothing else of the wait can
 * reach it; nothing when the retire secret is missing. With
 * `over: "own"` it writes only into an empty slot or over its own request, so
 * a Resend never replaces a newer sign-up another tab began. Answers whether
 * it wrote.
 */
export function writeLive(entry: LiveSignUp, over: "any" | "own" = "any"): boolean {
  const previous = asPrevious(entry);
  if (!previous || typeof entry.expiresAt !== "number") return false;
  if (over === "own") {
    const current = readLive();
    if (current && current.requestId !== previous.requestId) return false;
  }
  try {
    localStorage.setItem(
      LIVE_KEY,
      JSON.stringify({
        requestId: previous.requestId,
        retireSecret: previous.retireSecret,
        expiresAt: entry.expiresAt,
      }),
    );
    return true;
  } catch {
    // Storage disabled or full: other tabs cannot retire this request.
    return false;
  }
}

/** Removes the shared entry when it still names `requestId`; another tab's is left alone. */
export function clearLive(requestId: string): void {
  try {
    const raw = localStorage.getItem(LIVE_KEY);
    if (raw === null) return;
    const named = (JSON.parse(raw) as Partial<LiveSignUp> | null)?.requestId;
    if (named === requestId) localStorage.removeItem(LIVE_KEY);
  } catch {
    // Unreadable: `readLive` removes a malformed entry on its next read.
  }
}

/** The stored draft, field by field; a field of another shape reads as empty. */
export function storedDraft(): SignUpDraft {
  const stored = readStored<Partial<SignUpDraft>>(DRAFT_KEY);
  if (!stored || typeof stored !== "object") return EMPTY_DRAFT;
  const text = (value: unknown) => (typeof value === "string" ? value : "");
  return {
    email: text(stored.email),
    handle: text(stored.handle),
    birthdate: text(stored.birthdate),
    displayName: text(stored.displayName),
  };
}

/** Keeps `draft`, field by field; one with nothing typed removes the entry. */
export function writeDraft(draft: SignUpDraft): void {
  const { email, handle, birthdate, displayName } = draft;
  writeStored(
    DRAFT_KEY,
    email || handle || birthdate || displayName ? { email, handle, birthdate, displayName } : null,
  );
}

/** Removes the stored draft: the account it was for is made, or someone signed in. */
export function forgetDraft(): void {
  writeStored(DRAFT_KEY, null);
}

/** Keeps `enrolling` for every tab of the browser, field by field; nothing when storage refuses. */
export function keepEnrolling(enrolling: Enrolling): void {
  try {
    localStorage.setItem(
      ENROLLING_KEY,
      JSON.stringify({
        profileId: enrolling.profileId,
        handle: enrolling.handle,
        expiresAt: enrolling.expiresAt,
      }),
    );
  } catch {
    // Storage disabled or full: a reload starts over at the details.
  }
}

/**
 * Removes the stored enrolment. Given `profileId`, only when the entry names
 * that account: the slot is the whole browser's, and another tab's sign-up
 * may have written its own account over it since, which this tab leaves
 * alone. With none given, removes whatever is there.
 */
export function forgetEnrolling(profileId?: string): void {
  try {
    if (profileId !== undefined) {
      const raw = localStorage.getItem(ENROLLING_KEY);
      if (raw === null) return;
      const named = (JSON.parse(raw) as Partial<Enrolling> | null)?.profileId;
      if (named !== profileId) return;
    }
    localStorage.removeItem(ENROLLING_KEY);
  } catch {
    // Storage disabled, or an entry that does not parse: `storedEnrolling`
    // removes a malformed one on its next read.
  }
}

/** The stored enrolment, when it is whole and its session has not ended; removes one that is not. */
export function storedEnrolling(): Enrolling | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(ENROLLING_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  let stored: Partial<Enrolling> | null;
  try {
    stored = JSON.parse(raw) as Partial<Enrolling> | null;
  } catch {
    stored = null;
  }
  const { profileId, handle, expiresAt } = stored ?? {};
  if (
    typeof profileId !== "string" ||
    !profileId ||
    typeof handle !== "string" ||
    !handle ||
    typeof expiresAt !== "number" ||
    expiresAt <= Date.now()
  ) {
    forgetEnrolling();
    return null;
  }
  return { profileId, handle, expiresAt };
}

/**
 * Whether this tab has a sign-up to come back to — a link it waits on, or a
 * new account whose first passkey is still to be added — so a host can reopen
 * `<Register>` after a reload and let it resume. A draft alone does not count:
 * it shows when the person opens the form again. It also removes the shared
 * entry once its request has expired, so the entry does not stay on disk
 * past its request whichever page reads next.
 */
export function hasPendingSignUp(): boolean {
  if (typeof sessionStorage === "undefined") return false;
  readLive();
  return storedWaiting() !== null || storedEnrolling() !== null;
}
