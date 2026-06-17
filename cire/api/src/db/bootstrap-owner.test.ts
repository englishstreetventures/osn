import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_OWNER_SENTINEL,
  REPLACE_OWNER_PLACEHOLDER,
  resolveBootstrapOwnerProfileId,
} from "./setup";

// `resolveBootstrapOwnerProfileId` is the single gate for the bootstrap
// wedding's owner. In local it falls back to an ergonomic dev default; in any
// deployed environment (dev/staging/production) it MUST be supplied via
// `BOOTSTRAP_OWNER_PROFILE_ID`, be a real `usr_*` id, and never the legacy
// REPLACE placeholder — otherwise it throws so a misconfigured deploy cannot
// silently own the bootstrap wedding with a nonexistent profile.
describe("resolveBootstrapOwnerProfileId", () => {
  it("falls back to a dev default when OSN_ENV is local (or unset)", () => {
    expect(resolveBootstrapOwnerProfileId({})).toMatch(/^usr_/);
    expect(resolveBootstrapOwnerProfileId({ OSN_ENV: "local" })).toMatch(/^usr_/);
  });

  it("uses BOOTSTRAP_OWNER_PROFILE_ID when present and valid", () => {
    expect(
      resolveBootstrapOwnerProfileId({
        OSN_ENV: "production",
        BOOTSTRAP_OWNER_PROFILE_ID: "usr_realorganiser123",
      }),
    ).toBe("usr_realorganiser123");
  });

  for (const env of ["dev", "staging", "production"]) {
    it(`throws when BOOTSTRAP_OWNER_PROFILE_ID is missing and OSN_ENV is ${env}`, () => {
      expect(() => resolveBootstrapOwnerProfileId({ OSN_ENV: env })).toThrow(
        /BOOTSTRAP_OWNER_PROFILE_ID/,
      );
    });

    it(`throws when the id is the REPLACE placeholder and OSN_ENV is ${env}`, () => {
      expect(() =>
        resolveBootstrapOwnerProfileId({
          OSN_ENV: env,
          BOOTSTRAP_OWNER_PROFILE_ID: REPLACE_OWNER_PLACEHOLDER,
        }),
      ).toThrow(/placeholder/i);
    });

    it(`throws when the id is the inert sentinel and OSN_ENV is ${env}`, () => {
      expect(() =>
        resolveBootstrapOwnerProfileId({
          OSN_ENV: env,
          BOOTSTRAP_OWNER_PROFILE_ID: BOOTSTRAP_OWNER_SENTINEL,
        }),
      ).toThrow(/placeholder|sentinel/i);
    });

    it(`throws when the id does not look like a usr_* id and OSN_ENV is ${env}`, () => {
      expect(() =>
        resolveBootstrapOwnerProfileId({
          OSN_ENV: env,
          BOOTSTRAP_OWNER_PROFILE_ID: "acct_not_a_profile",
        }),
      ).toThrow(/usr_/);
    });
  }
});
