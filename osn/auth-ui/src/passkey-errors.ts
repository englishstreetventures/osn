import { describeAuthError, isAuthExpiredError, type AuthErrorContext } from "@osn/client";

/** Which WebAuthn ceremony failed: adding a passkey, or using one. */
export type PasskeyCeremony = "registration" | "authentication";

const GENERAL = "Something went wrong with the passkey. Try again.";

/**
 * One sentence per `DOMException` name a WebAuthn ceremony fails with, the
 * same for both ceremonies. `@simplewebauthn/browser` wraps the browser's
 * error in a `WebAuthnError` that keeps its `name`, so the name is all this
 * reads.
 */
const BY_NAME = {
  AbortError: "The passkey request was stopped. Try again.",
  SecurityError: "Your browser didn't allow a passkey here. Try another browser or device.",
  NotSupportedError: "This device can't use a passkey here. Try another device or a security key.",
  ConstraintError: "This device can't use a passkey here. Try another device or a security key.",
} as const satisfies Record<string, string>;

/**
 * The names whose sentence depends on the ceremony.
 *
 * `NotAllowedError` covers a closed prompt and a timeout in both. Signing in,
 * it also covers no passkey for this site on this device and a passkey that
 * no longer signs in here, so its sentence names no cause, and a view that
 * offers another way in shows that way beside it. Adding a passkey, no
 * passkey was made, so the sentence says that instead.
 *
 * `InvalidStateError` means "this device already holds a passkey for the
 * account" only when adding one (`excludeCredentials`); signing in, it gets
 * the general sentence.
 */
const BY_CEREMONY = {
  authentication: {
    NotAllowedError: "That passkey didn't work. Try again.",
  },
  registration: {
    NotAllowedError: "The passkey wasn't added. Try again.",
    InvalidStateError: "This device already has a passkey for this account.",
  },
} as const satisfies Record<PasskeyCeremony, Record<string, string>>;

/** The `describeAuthError` context for a server refusal during each ceremony. */
const SERVER_CONTEXT = {
  authentication: "passkey",
  registration: "new-passkey",
} as const satisfies Record<PasskeyCeremony, AuthErrorContext>;

function lookup(table: Readonly<Record<string, string>>, name: string): string | undefined {
  return Object.hasOwn(table, name) ? table[name] : undefined;
}

/**
 * One plain sentence for a failed passkey step, for a person to read.
 *
 * A browser ceremony's failure is read by its `name` alone — never its
 * `message`, which carries the browser's own text and, in Chrome, a URL — and
 * by `ceremony`, which the caller passes to say which one ran. A failure from
 * an `@osn/client` call in the same flow (any error with a numeric `status`,
 * a transport failure at status `0` included, or an expired session) gets
 * `describeAuthError` with the ceremony's context (`passkey` signing in,
 * `new-passkey` adding one), so a passkey `catch` needs this one call.
 * Anything else gets the general sentence. Never throws.
 */
export function describePasskeyError(err: unknown, ceremony: PasskeyCeremony): string {
  try {
    if (!Object.hasOwn(BY_CEREMONY, ceremony)) return GENERAL;
    if (isAuthExpiredError(err)) return describeAuthError(err, SERVER_CONTEXT[ceremony]);
    if ((typeof err !== "object" && typeof err !== "function") || err === null) return GENERAL;
    const { status, name } = err as { status?: unknown; name?: unknown };
    if (typeof status === "number" && Number.isFinite(status)) {
      return describeAuthError(err, SERVER_CONTEXT[ceremony]);
    }
    if (typeof name !== "string") return GENERAL;
    return lookup(BY_CEREMONY[ceremony], name) ?? lookup(BY_NAME, name) ?? GENERAL;
  } catch {
    // A throwing getter or a revoked Proxy is not a known failure.
    return GENERAL;
  }
}
