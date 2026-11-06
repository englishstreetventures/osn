import { describeAuthError, isAuthExpiredError } from "@osn/client";

/** Which WebAuthn ceremony failed: adding a passkey, or using one. */
export type PasskeyCeremony = "registration" | "authentication";

const GENERAL = "Something went wrong with the passkey. Try again.";

/**
 * One sentence per `DOMException` name a WebAuthn ceremony fails with, the
 * same for both ceremonies. `@simplewebauthn/browser` wraps the browser's
 * error in a `WebAuthnError` that keeps its `name`, so the name is all this
 * reads. `NotAllowedError` covers a closed prompt, a timeout, no passkey for
 * this site on this device and a passkey that no longer signs in here alike,
 * so its sentence names none of them; a view that offers another way in shows
 * that way beside it.
 */
const BY_NAME = {
  NotAllowedError: "That passkey didn't work. Try again.",
  AbortError: "The passkey request was stopped. Try again.",
  SecurityError: "Your browser didn't allow a passkey here. Try another browser or device.",
  NotSupportedError: "This device can't use a passkey here. Try another device or a security key.",
  ConstraintError: "This device can't use a passkey here. Try another device or a security key.",
} as const satisfies Record<string, string>;

type PasskeyFailureName = keyof typeof BY_NAME;

/**
 * `InvalidStateError` means "this device already holds a passkey for the
 * account" only when adding one (`excludeCredentials`); from any other
 * ceremony, or when the caller does not say, it gets the general sentence.
 */
const ALREADY_REGISTERED = "This device already has a passkey for this account.";

/**
 * One plain sentence for a failed passkey step, for a person to read.
 *
 * A browser ceremony's failure is read by its `name` alone — never its
 * `message`, which carries the browser's own text and, in Chrome, a URL — and
 * by `ceremony`, which the caller passes to say which one ran. A failure from
 * an `@osn/client` call in the same flow (any error with a numeric `status`,
 * a transport failure at status `0` included, or an expired session) gets
 * `describeAuthError(err, "passkey")`, so a passkey `catch` needs this one
 * call. Anything else gets the general sentence. Never throws.
 */
export function describePasskeyError(err: unknown, ceremony?: PasskeyCeremony): string {
  try {
    if (isAuthExpiredError(err)) return describeAuthError(err, "passkey");
    if ((typeof err !== "object" && typeof err !== "function") || err === null) return GENERAL;
    const { status, name } = err as { status?: unknown; name?: unknown };
    if (typeof status === "number" && Number.isFinite(status)) {
      return describeAuthError(err, "passkey");
    }
    if (name === "InvalidStateError" && ceremony === "registration") return ALREADY_REGISTERED;
    if (typeof name === "string" && Object.hasOwn(BY_NAME, name)) {
      return BY_NAME[name as PasskeyFailureName];
    }
  } catch {
    // A throwing getter or a revoked Proxy is not a known failure.
  }
  return GENERAL;
}
