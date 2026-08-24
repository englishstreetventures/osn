import type { RunPasskeyRegistration } from "@osn/ui/auth/StepUpDialog";
import { startRegistration } from "@simplewebauthn/browser";

/**
 * This app's WebAuthn attestation (enrolment) ceremony runner, handed to
 * `@osn/ui`'s `PasskeysView` as the `runPasskeyRegistration` prop.
 *
 * Kept out of `webauthn-ceremony.ts`: registration only runs from the
 * Security tab (`SecuritySection`), which is already its own lazy chunk. The
 * banner (`SecurityEventsBannerMount`, mounted on every settings visit) never
 * imports this module, so `startRegistration` does not ship in its chunk.
 *
 * WHY THE ASSERTION IS HERE AND IS SAFE:
 * The options come off the wire typed as the STANDARD lib.dom
 * `PublicKeyCredentialCreationOptionsJSON` (see `PasskeysClient.registerBegin`).
 * `@simplewebauthn/browser` re-declares that dictionary in its own types with
 * narrower members — `userVerification` as the `UserVerificationRequirement`
 * union rather than lib.dom's `string`, `hints` as `PublicKeyCredentialHint[]`
 * rather than `string[]`. The shape is the same WebAuthn JSON; only the
 * string members are spelled tighter. Widening in that direction is not
 * something the compiler can check, so it is asserted once, here, rather than
 * at each call site that used to carry an inline
 * `as Parameters<typeof startRegistration>[0]["optionsJSON"]`.
 *
 * The values themselves are minted by osn-api and parsed by the browser's
 * authenticator; a member outside the narrower union would be rejected by the
 * WebAuthn ceremony itself, not silently misread here.
 */

/** Runs the attestation (enrolment) ceremony. */
export const runPasskeyRegistration: RunPasskeyRegistration = (options) =>
  startRegistration({
    optionsJSON: options as Parameters<typeof startRegistration>[0]["optionsJSON"],
  });
