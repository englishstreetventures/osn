import type { RunPasskeyCeremony } from "@osn/ui/auth/StepUpDialog";
import { startAuthentication } from "@simplewebauthn/browser";

/**
 * This app's WebAuthn assertion (sign-in / step-up) ceremony runner, handed
 * to the `@osn/ui` auth surfaces (`StepUpDialog`, `PasskeysView`,
 * `SecurityEventsBanner`, …) as the `runPasskeyCeremony` prop.
 *
 * `@osn/ui` deliberately does not import the `@simplewebauthn/browser` runtime
 * — hosts wire their own wrapper — so this module is where the two meet, and
 * it exists so that meeting happens exactly once instead of being re-typed
 * inline in every component that mounts one of those surfaces.
 *
 * Kept in its own module, separate from `webauthn-registration.ts`: the
 * `SecurityEventsBanner` mounts on every settings visit and only ever runs
 * this ceremony, never registration. A single shared module would drag
 * `startRegistration` into the banner's lazy chunk even though it is only
 * needed by the rarely-visited Security tab (`SecuritySection`).
 *
 * WHY THE ASSERTION IS HERE AND IS SAFE:
 * The options come off the wire typed as the STANDARD lib.dom
 * `PublicKeyCredentialRequestOptionsJSON` (see `StepUpClient.passkeyBegin`).
 * `@simplewebauthn/browser` re-declares that dictionary in its own types with
 * narrower members — `userVerification` as the `UserVerificationRequirement`
 * union rather than lib.dom's `string`, `hints` as `PublicKeyCredentialHint[]`
 * rather than `string[]`. The shape is the same WebAuthn JSON; only the
 * string members are spelled tighter. Widening in that direction is not
 * something the compiler can check, so it is asserted once, here, rather than
 * at each call site that used to carry an inline
 * `as Parameters<typeof startAuthentication>[0]["optionsJSON"]`.
 *
 * The values themselves are minted by osn-api and parsed by the browser's
 * authenticator; a member outside the narrower union would be rejected by the
 * WebAuthn ceremony itself, not silently misread here.
 */

/** Runs the assertion (sign-in / step-up) ceremony. */
export const runPasskeyCeremony: RunPasskeyCeremony = (options) =>
  startAuthentication({
    optionsJSON: options as Parameters<typeof startAuthentication>[0]["optionsJSON"],
  });
