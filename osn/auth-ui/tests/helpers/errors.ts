/**
 * Errors shaped as the views meet them, each carrying planted text that must
 * never reach the screen: the views show a sentence from `describeAuthError`
 * or `describePasskeyError`, which read the error's `status`, `code` and
 * `name`, never its `message`.
 */

/** A refusal from an `@osn/client` call, as `OsnApiError` carries it. */
export function apiError(planted: string, status = 400, code = "invalid_request"): Error {
  return Object.assign(new Error(planted), { status, code });
}

/** A WebAuthn ceremony's failure: the browser's `DOMException` name and its own text. */
export function ceremonyError(name: string, planted: string): Error {
  const error = new Error(planted);
  error.name = name;
  return error;
}

/** The map's sentence for a 400 or 422 with no context. */
export const INPUT = "That didn't work. Try again.";
/** The map's sentence for a call that got no answer (status 0). */
export const CONNECTION = "We couldn't connect. Check your connection and try again.";
/** The map's sentence for a code that got no answer (status 0, `code` context). */
export const CODE_NO_ANSWER =
  "We couldn't connect. Check your connection, then try again with a new code.";
/** The map's sentence for a 429. */
export const WAIT = "Too many attempts. Wait a while, then try again.";
/** The map's sentence for a refused code. */
export const CODE =
  "That code didn't work. Check it or get a new one, then try again. If it keeps failing, wait a while first.";
/** The map's sentence for a refused recovery attempt. */
export const RECOVERY =
  "That didn't work. Check your handle or email and the code, then try again. If it keeps failing, wait a while first.";
/** The map's sentence for a refused form of details. */
export const DETAILS = "Check the details you entered and try again.";
/** The map's sentence for a failed verification check (`turnstile_failed`). */
export const CHECK_FAILED =
  "The verification check didn't pass. Complete it once more and try again.";
/** The map's sentence for a 5xx. */
export const SERVER = "Something went wrong on our side. Try again.";
/** `describePasskeyError`'s sentence for a closed prompt when signing in. */
export const PASSKEY_NOT_USED = "That passkey didn't work. Try again.";
/** `describePasskeyError`'s sentence for a closed prompt when adding a passkey. */
export const PASSKEY_NOT_ADDED = "The passkey wasn't added. Try again.";
/** `describePasskeyError`'s sentence for a failure it has no name for. */
export const PASSKEY_GENERAL = "Something went wrong with the passkey. Try again.";

/** Every `role="alert"` element's text, joined, for a "planted text is absent" check. */
export function alertsText(root: ParentNode = document): string {
  return [...root.querySelectorAll('[role="alert"]')].map((el) => el.textContent ?? "").join(" ");
}
