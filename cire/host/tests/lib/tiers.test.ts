import { describe, expect, it } from "vitest";

import {
  isPaidTier,
  isTier,
  legacyTierFromEntitlements,
  TIER_LABEL,
  TIERS,
  tierAtLeast,
  tierOf,
} from "../../src/lib/tiers";

/**
 * The portal's mirror of the API's tier rules. Every lock in the portal ranks
 * the wedding's tier through `tierAtLeast`, and every wedding's tier is read
 * through `tierOf` — so a wrong answer here opens a module the API refuses, or
 * hides one the organiser paid for.
 */
describe("TIERS", () => {
  it("ranks the tiers lowest first", () => {
    // The API's own list is compared in `tiers.contract.test.ts`.
    expect([...TIERS]).toEqual(["ivory", "gold", "crimson"]);
  });

  it("labels every tier", () => {
    expect(Object.keys(TIER_LABEL).toSorted()).toEqual([...TIERS].toSorted());
  });
});

describe("tierAtLeast", () => {
  it("holds for the same tier and every tier below it", () => {
    expect(tierAtLeast("ivory", "ivory")).toBe(true);
    expect(tierAtLeast("gold", "ivory")).toBe(true);
    expect(tierAtLeast("gold", "gold")).toBe(true);
    expect(tierAtLeast("crimson", "gold")).toBe(true);
    expect(tierAtLeast("crimson", "crimson")).toBe(true);
  });

  it("fails for every tier above", () => {
    expect(tierAtLeast("ivory", "gold")).toBe(false);
    expect(tierAtLeast("ivory", "crimson")).toBe(false);
    expect(tierAtLeast("gold", "crimson")).toBe(false);
  });
});

describe("isTier / isPaidTier", () => {
  it("accepts only the three tier names", () => {
    for (const tier of TIERS) expect(isTier(tier)).toBe(true);
    for (const value of ["", "Gold", "platinum", "constructor", null, undefined, 1]) {
      expect(isTier(value), `${String(value)}`).toBe(false);
    }
  });

  it("calls Gold and Crimson paid, and Ivory not", () => {
    expect(isPaidTier("gold")).toBe(true);
    expect(isPaidTier("crimson")).toBe(true);
    expect(isPaidTier("ivory")).toBe(false);
    expect(isPaidTier("platinum")).toBe(false);
  });
});

describe("legacyTierFromEntitlements", () => {
  it("maps the legacy keys the way the tier migration did", () => {
    expect(legacyTierFromEntitlements([])).toBe("ivory");
    expect(legacyTierFromEntitlements(["premium_templates"])).toBe("ivory");
    expect(legacyTierFromEntitlements(["registry"])).toBe("gold");
    expect(legacyTierFromEntitlements(["capacity_500"])).toBe("gold");
    expect(legacyTierFromEntitlements(["vendors"])).toBe("crimson");
    expect(legacyTierFromEntitlements(["capacity_1000"])).toBe("crimson");
  });

  it("takes the higher tier when the keys name both", () => {
    expect(legacyTierFromEntitlements(["registry", "vendors"])).toBe("crimson");
    expect(legacyTierFromEntitlements(["capacity_500", "capacity_1000"])).toBe("crimson");
  });
});

describe("tierOf", () => {
  it("reads the list's tier when it sent one", () => {
    expect(tierOf({ tier: "gold", entitlements: [] })).toBe("gold");
    // The tier wins over keys that would say otherwise.
    expect(tierOf({ tier: "ivory", entitlements: ["vendors"] })).toBe("ivory");
  });

  it("falls back to the legacy keys when the API sent no tier", () => {
    expect(tierOf({ entitlements: ["registry"] })).toBe("gold");
    expect(tierOf({ entitlements: ["vendors", "registry"] })).toBe("crimson");
    expect(tierOf({})).toBe("ivory");
  });

  it("reads a tier it does not know as Ivory, so it can never open a module", () => {
    expect(tierOf({ tier: "platinum", entitlements: ["vendors"] })).toBe("ivory");
    expect(tierOf({ tier: null, entitlements: ["vendors"] })).toBe("ivory");
  });
});
