import { describe, expect, it } from "vitest";

import { DESIGNS, isDesignId } from "../src/index";

describe("invite design catalog", () => {
  it("has unique ids", () => {
    expect(new Set(DESIGNS.map((d) => d.id)).size).toBe(DESIGNS.length);
  });

  it("accepts every catalog id", () => {
    for (const d of DESIGNS) expect(isDesignId(d.id)).toBe(true);
  });

  it("rejects unknown ids and non-strings", () => {
    expect(isDesignId("not-a-design")).toBe(false);
    expect(isDesignId(42)).toBe(false);
    expect(isDesignId(null)).toBe(false);
    expect(isDesignId(undefined)).toBe(false);
  });
});
