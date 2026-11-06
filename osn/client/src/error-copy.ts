import { isAuthExpiredError } from "./errors";

/**
 * What the person just submitted, chosen by the caller from the form it
 * showed. It changes only the sentence for a `400` or `422` refusal — the
 * answer the server gives to every wrong input — so it tells the person
 * nothing the server's answer does not.
 *
 * - `code`: a one-time code (emailed, or from an authenticator app) for an
 *   account already named.
 * - `recovery`: a handle or email with a recovery code, emailed code or app
 *   code.
 * - `passkey`: a passkey the server refused.
 * - `details`: a form of email, handle or date of birth.
 */
export type AuthErrorContext = "code" | "recovery" | "passkey" | "details";

/** The `error` codes osn-api sends to the routes this package's clients call. */
export type OsnApiErrorCode =
  | "invalid_request"
  | "turnstile_failed"
  | "handle_mismatch"
  | "unauthorized"
  | "step_up_required"
  | "forbidden"
  | "not_found"
  | "session_stale"
  | "age_restricted"
  | "rate_limited"
  | "internal_error"
  | "temporarily_unavailable"
  | "login_required"
  | "invalid_client";

const GENERAL = "Something went wrong. Try again.";
const CONNECTION = "We couldn't connect. Check your connection and try again.";
const WAIT = "Too many attempts. Wait a while, then try again.";
const SESSION_ENDED = "Your session has ended. Sign in again.";
const BLOCKED = "That request was blocked. Reload and try again.";
const GONE = "That's no longer here. Reload and try again.";
const CHANGED = "Something changed. Reload and try again.";
const SERVER = "Something went wrong on our side. Try again.";
const INPUT = "That didn't work. Try again.";

/**
 * The sentence for a refused input, by what was submitted. The server answers
 * a wrong code and a locked-out account the same way, so the `code` and
 * `recovery` sentences say to wait when the code keeps failing.
 */
const INPUT_BY_CONTEXT = {
  code: "That code didn't work. Check it or get a new one, then try again. If it keeps failing, wait a while first.",
  recovery:
    "That didn't work. Check your handle or email and the code, then try again. If it keeps failing, wait a while first.",
  passkey: "We couldn't verify that passkey. Try again.",
  details: "Check the details you entered and try again.",
} as const satisfies Record<AuthErrorContext, string>;

/** Stands in a table entry for "the refused-input sentence for the caller's context". */
const REFUSED_INPUT = "refused-input";

/** One code's sentences, by the HTTP status it is sent with. */
interface SentenceByStatus {
  readonly [status: number]: string;
}

/**
 * The sentence for each code at each status the server sends it with. A code
 * at a status it is not listed under takes its status's class sentence.
 */
const BY_CODE = {
  invalid_request: {
    400: REFUSED_INPUT,
    404: "This sign-in request has expired. Go back to the app and start again.",
  },
  turnstile_failed: {
    400: "The verification check didn't pass. Complete it once more and try again.",
  },
  handle_mismatch: { 400: "The handle you typed doesn't match. Check it and try again." },
  unauthorized: { 401: SESSION_ENDED },
  step_up_required: { 403: "Confirm it's you, then try again." },
  forbidden: { 403: BLOCKED },
  not_found: { 404: GONE },
  session_stale: { 409: "For your security, sign in again to finish this." },
  age_restricted: { 422: "You must be 13 or older to create an account." },
  rate_limited: { 429: WAIT },
  internal_error: { 500: SERVER },
  temporarily_unavailable: { 503: SERVER },
  login_required: { 400: "Sign in again to continue." },
  invalid_client: {
    401: "This app is no longer available.",
    404: "This app is no longer available.",
  },
} as const satisfies Record<OsnApiErrorCode, SentenceByStatus>;

/** The sentence `code` maps to at `status`, if the table lists that pair. */
function sentenceFor(code: string, status: number): string | undefined {
  if (!Object.hasOwn(BY_CODE, code)) return undefined;
  return sentenceAt(BY_CODE[code as OsnApiErrorCode], status);
}

function sentenceAt(byStatus: SentenceByStatus, status: number): string | undefined {
  return Object.hasOwn(byStatus, status) ? byStatus[status] : undefined;
}

function byStatusClass(status: number, refusedInput: string): string {
  if (status === 400 || status === 422) return refusedInput;
  if (status === 401) return SESSION_ENDED;
  if (status === 403) return BLOCKED;
  if (status === 404) return GONE;
  if (status === 409) return CHANGED;
  if (status >= 500 && status <= 599) return SERVER;
  return GENERAL;
}

/**
 * One plain sentence for a failed auth call, for a person to read.
 *
 * The sentence depends on `context`, on `isAuthExpiredError(err)`, and on the
 * error's `status` and `code` (as every `OsnApiError` and
 * `ProfileManagementError` carries them), and on nothing else: never the
 * message, the cause or any other field. Two failures the server answers the
 * same way therefore always read the same, so the sentence never reveals more
 * than the answer did — whether an account exists, or which of two inputs was
 * wrong. A `429` names the wait
 * without a time. Any other input — a thrown string, `null`, an error with no
 * status — gets the general sentence. Never throws.
 */
export function describeAuthError(err: unknown, context?: AuthErrorContext): string {
  let status: unknown;
  let code: unknown;
  try {
    if (isAuthExpiredError(err)) return SESSION_ENDED;
    if ((typeof err !== "object" && typeof err !== "function") || err === null) return GENERAL;
    ({ status, code } = err as { status?: unknown; code?: unknown });
  } catch {
    return GENERAL;
  }
  if (typeof status !== "number" || !Number.isFinite(status)) return GENERAL;
  if (status === 0) return CONNECTION;
  if (status === 429) return WAIT;

  const refusedInput: string =
    context !== undefined && Object.hasOwn(INPUT_BY_CONTEXT, context)
      ? INPUT_BY_CONTEXT[context]
      : INPUT;
  const sentence = typeof code === "string" ? sentenceFor(code, status) : undefined;
  if (sentence === undefined) return byStatusClass(status, refusedInput);
  return sentence === REFUSED_INPUT ? refusedInput : sentence;
}
