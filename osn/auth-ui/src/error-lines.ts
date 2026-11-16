import { describeAuthError, isAuthExpiredError } from "@osn/client";

/**
 * An error line about one field: its sentence, and whether it says the value
 * typed there was refused.
 *
 * `invalid` sets the field's `aria-invalid`, so a screen reader says "invalid
 * entry" only when the input was the problem — never for a rate limit, an
 * outage, a closed passkey prompt or an unfinished challenge. The line is tied
 * to the field through `aria-describedby` whatever the cause, so the field
 * reads the same words for every one.
 */
export interface FieldError {
  readonly text: string;
  readonly invalid: boolean;
}

/**
 * The line for a failed call: `text`, marked invalid only when the server
 * refused the input — a `400` or `422` that is not the verification check.
 * Reads `status` and `code` alone, as the sentence helpers do.
 */
export function fieldError(text: string, err: unknown): FieldError {
  let invalid = false;
  try {
    if (typeof err === "object" && err !== null) {
      const { status, code } = err as { status?: unknown; code?: unknown };
      invalid = (status === 400 || status === 422) && code !== "turnstile_failed";
    }
  } catch {
    // A throwing getter says nothing about the input.
  }
  return { text, invalid };
}

/** A line from a check this side ran on the input itself: always invalid. */
export function inputError(text: string): FieldError {
  return { text, invalid: true };
}

/** A line about a field that says nothing about what was typed in it. */
export function plainError(text: string): FieldError {
  return { text, invalid: false };
}

/** The error's numeric `status`, if it carries one. */
export function statusOf(err: unknown): number | undefined {
  try {
    if (typeof err !== "object" || err === null) return undefined;
    const { status } = err as { status?: unknown };
    return typeof status === "number" ? status : undefined;
  } catch {
    // A throwing getter is not a status.
    return undefined;
  }
}

/** Whether a failed call says the session has ended. */
function sessionEnded(err: unknown): boolean {
  return isAuthExpiredError(err) || statusOf(err) === 401;
}

/**
 * What a failed read adds after its view's own lead ("Your passkeys didn't
 * load."): the map's sentence when it says something the lead does not — a
 * `429` says to wait, status `0` says to check the connection, an ended
 * session says to sign in — and nothing otherwise, since the map's other
 * sentences only repeat "something went wrong, try again" beside a Try again
 * button.
 */
export function loadFailureDetail(err: unknown): string | undefined {
  const status = statusOf(err);
  return sessionEnded(err) || status === 429 || status === 0 ? describeAuthError(err) : undefined;
}

/**
 * Whether retrying a failed read can work. Not once the session has ended:
 * the host's own sign-in is the way on.
 */
export function canRetryLoad(err: unknown): boolean {
  return !sessionEnded(err);
}

/** Joins the ids a field is described by, leaving out the absent ones. */
export function describedBy(...ids: (string | false | null | undefined)[]): string | undefined {
  const joined = ids.filter((id): id is string => typeof id === "string" && id !== "").join(" ");
  return joined === "" ? undefined : joined;
}
