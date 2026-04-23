// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";

import * as authIndex from "../../src/auth";

/**
 * Public API surface guard. Each assertion locks in the shape of
 * `@osn/ui/auth` against accidental re-additions or removals.
 */
describe("@osn/ui/auth public exports", () => {
  it("does not export MagicLinkHandler (deleted in the passkey-primary PR)", () => {
    // Magic-link was the primary-login surface that passkey-primary
    // deleted; re-adding it would silently re-introduce an attack surface
    // the security backlog deliberately closed.
    expect("MagicLinkHandler" in authIndex).toBe(false);
  });

  it("exposes the expected primary components", () => {
    const keys = new Set(Object.keys(authIndex));
    for (const expected of [
      "ChangeEmailForm",
      "CreateProfileForm",
      "PasskeysView",
      "ProfileOnboarding",
      "ProfileSwitcher",
      "RecoveryCodesView",
      "RecoveryLoginForm",
      "Register",
      "SecurityEventsBanner",
      "SessionsView",
      "SignIn",
      "StepUpDialog",
    ]) {
      expect(keys.has(expected)).toBe(true);
    }
  });
});
