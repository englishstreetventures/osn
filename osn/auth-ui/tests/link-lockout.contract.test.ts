import { describe, expect, it } from "vitest";

import {
  RECOVERY_LOCKOUT_MS,
  RECOVERY_LOCKOUT_THRESHOLD,
} from "../../api/src/lib/recovery-lockout-store";
import {
  REGISTRATION_LINK_LOCKOUT_MS,
  REGISTRATION_LINK_LOCKOUT_THRESHOLD,
} from "../../api/src/services/auth/constants";
import { LINK_LOCKOUT } from "../src/link-lockout";

/**
 * The lockout rule the link page states, against the numbers osn-api enforces.
 *
 * `@osn/auth-ui` cannot import osn-api, so `LINK_LOCKOUT` is a hand-kept copy:
 * a threshold or a window changed on the server alone would leave the page
 * telling people a rule that no longer holds. This file reads osn-api's own
 * constants and fails when either side changes alone. Sign-up and email change
 * count wrong numbers on the address's counter; recovery and step-up each on
 * the account's, with recovery's numbers.
 *
 * Reads files outside the package, so it runs as the `repo` project
 * (`test:repo`), which turbo reruns when those files change.
 */
describe("the link page's lockout rule matches osn-api's", () => {
  it.each(["sign-up", "email-change"] as const)("%s: the address's counter", (purpose) => {
    expect(LINK_LOCKOUT[purpose]).toEqual({
      wrong: REGISTRATION_LINK_LOCKOUT_THRESHOLD,
      windowMs: REGISTRATION_LINK_LOCKOUT_MS,
      scope: "address",
    });
  });

  it.each(["recovery", "step-up"] as const)("%s: the account's counter", (purpose) => {
    expect(LINK_LOCKOUT[purpose]).toEqual({
      wrong: RECOVERY_LOCKOUT_THRESHOLD,
      windowMs: RECOVERY_LOCKOUT_MS,
      scope: "account",
    });
  });
});
