import type { RunPasskeyCeremony, RunPasskeyRegistration } from "@osn/ui/auth/StepUpDialog";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";

/**
 * This app's WebAuthn ceremony runners, handed to the `@osn/ui` auth surfaces
 * (`StepUpDialog`, `PasskeysView`, `SecurityEventsBanner`, …) as the
 * `runPasskeyCeremony` / `runPasskeyRegistration` props.
 *
 * `@osn/ui` deliberately does not import the `@simplewebauthn/browser` runtime
 * — hosts wire their own wrapper — so this module is where the two meet, and
 * it exists so that meeting happens exactly once instead of being re-typed
 * inline in every component that mounts one of those surfaces.
 *
 * WHY THE ASSERTIONS ARE HERE AND ARE SAFE:
 * The options come off the wire typed as the STANDARD lib.dom
 * `PublicKeyCredential{Request,Creation}OptionsJSON` (see
 * `StepUpClient.passkeyBegin` / `PasskeysClient.registerBegin`).
 * `@simplewebauthn/browser` re-declares those two dictionaries in its own
 * types with narrower members — `userVerification` as the
 * `UserVerificationRequirement` union rather than lib.dom's `string`, `hints`
 * as `PublicKeyCredentialHint[]` rather than `string[]`. The shapes are the
 * same WebAuthn JSON; only the string members are spelled tighter. Widening in
 * that direction is not something the compiler can check, so it is asserted
 * once, here, rather than at each of the three call sites that used to carry
 * an inline `as Parameters<typeof startAuthentication>[0]["optionsJSON"]`.
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

/** Runs the attestation (enrolment) ceremony. */
export const runPasskeyRegistration: RunPasskeyRegistration = (options) =>
  startRegistration({
    optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"],
  });
