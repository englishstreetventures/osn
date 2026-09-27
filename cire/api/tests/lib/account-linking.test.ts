import { describe, expect, it } from "bun:test";

import { FLAGS, type FeatureFlags, type FlagAttributes } from "@shared/feature-flags";

import { ACCOUNT_LINKING_FLAG, isAccountLinkingOn } from "../../src/lib/account-linking";

/**
 * A flag provider whose answer depends on the id it is asked about, so a check
 * that buckets on anything but the household would get the wrong answer.
 */
function flagsOnFor(familyIds: string[]): FeatureFlags & { asked: (FlagAttributes | undefined)[] } {
  const asked: (FlagAttributes | undefined)[] = [];
  return {
    asked,
    async forRequest(attributes) {
      asked.push(attributes);
      const on = attributes?.id !== undefined && familyIds.includes(attributes.id);
      return {
        isOn: (key) => key === ACCOUNT_LINKING_FLAG && on,
        getValue: (key) => FLAGS[key],
      };
    },
  };
}

describe("isAccountLinkingOn", () => {
  it("asks the flag about this household, and answers per household", async () => {
    const flags = flagsOnFor(["fam_a"]);
    expect(await isAccountLinkingOn({ flags, canLink: true }, "fam_a")).toBe(true);
    expect(await isAccountLinkingOn({ flags, canLink: true }, "fam_b")).toBe(false);
    expect(flags.asked).toEqual([{ id: "fam_a" }, { id: "fam_b" }]);
  });

  it("is off where a link cannot complete, whatever the flag says", async () => {
    const flags = flagsOnFor(["fam_a"]);
    expect(await isAccountLinkingOn({ flags, canLink: false }, "fam_a")).toBe(false);
    // Nothing to decide, so the flag is not even asked.
    expect(flags.asked).toEqual([]);
  });

  it("reads a throwing flag provider as off, and never rejects", async () => {
    const flags: FeatureFlags = {
      forRequest: () => Promise.reject(new Error("flag outage")),
    };
    expect(await isAccountLinkingOn({ flags, canLink: true }, "fam_a")).toBe(false);
  });
});
