import { describeAuthError, isAuthExpiredError } from "@osn/client";

const GENERAL = "Something went wrong with the passkey. Try again.";

/**
 * One sentence per `DOMException` name a WebAuthn ceremony fails with.
 * `@simplewebauthn/browser` wraps the browser's error in a `WebAuthnError`
 * that keeps its `name`, so the name is all this reads. `NotAllowedError`
 * covers a closed prompt, a timeout and "no passkey for this site on this
 * device" alike, so its sentence blames none of them.
 */
const BY_NAME = {
  NotAllowedError: "The passkey prompt was closed or timed out. Try again.",
  AbortError: "The passkey request was stopped. Try again.",
  InvalidStateError: "This device already has a passkey for this account.",
  SecurityError: "Your browser didn't allow a passkey here. Try another browser or device.",
  NotSupportedError: "This device can't use a passkey here. Try another device or a security key.",
  ConstraintError: "This device can't use a passkey here. Try another device or a security key.",
} as const satisfies Record<string, string>;

type PasskeyFailureName = keyof typeof BY_NAME;

/**
 * One plain sentence for a failed passkey step, for a person to read.
 *
 * A browser ceremony's failure is read by its `name` alone — never its
 * `message`, which carries the browser's own text and, in Chrome, a URL. A
 * failure from an `@osn/client` call in the same flow (any error with a
 * numeric `status`, a transport failure at status `0` included, or an
 * expired session) gets `describeAuthError(err, "passkey")`, so a passkey
 * `catch` needs this one call. Anything else gets the general sentence.
 * Never throws.
 */
export function describePasskeyError(err: unknown): string {
  try {
    if (isAuthExpiredError(err)) return describeAuthError(err, "passkey");
    if ((typeof err !== "object" && typeof err !== "function") || err === null) return GENERAL;
    const { status, name } = err as { status?: unknown; name?: unknown };
    if (typeof status === "number" && Number.isFinite(status)) {
      return describeAuthError(err, "passkey");
    }
    if (typeof name === "string" && Object.hasOwn(BY_NAME, name)) {
      return BY_NAME[name as PasskeyFailureName];
    }
  } catch {
    // A throwing getter or a revoked Proxy is not a known failure.
  }
  return GENERAL;
}
