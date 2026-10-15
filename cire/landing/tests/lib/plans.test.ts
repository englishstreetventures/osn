import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { GOLD_TO_CRIMSON_PRICE, PLANS } from "../../src/lib/plans";

describe("public wedding plans", () => {
  it("publishes the approved one-time AUD offer", () => {
    expect(PLANS.map(({ id, price }) => ({ id, price }))).toEqual([
      { id: "ivory", price: 0 },
      { id: "gold", price: 79 },
      { id: "crimson", price: 149 },
    ]);
    expect(GOLD_TO_CRIMSON_PRICE).toBe(70);
  });

  it("keeps advertised guest limits equal to the enforced limits", () => {
    const source = readFileSync(
      `${import.meta.dirname}/../../../api/src/services/tiers.ts`,
      "utf8",
    );
    const caps = source.match(/export const TIER_GUEST_CAP = \{([\s\S]*?)\}/)?.[1];
    expect(caps).toBeDefined();
    for (const plan of PLANS) {
      expect(caps).toMatch(new RegExp(`\\b${plan.id}: ${plan.guestCap}\\b`));
    }
  });
});
