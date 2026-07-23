import { describe, expect, it } from "vitest";

import { DEFAULT_DESIGN_ID, DESIGNS, isDesignId } from "./index";

describe("invite design catalog", () => {
  it("contains classic as a free design", () => {
    expect(DESIGNS).toContainEqual({ id: "classic", name: "Classic", tier: "free" });
  });

  it("defaults to classic", () => {
    expect(DEFAULT_DESIGN_ID).toBe("classic");
  });

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

  it("contains gala as a free design", () => {
    expect(DESIGNS).toContainEqual({ id: "gala", name: "Gala", tier: "free" });
  });
});
