import { describe, it, expect } from "vitest";

import { truncateSwatchName } from "../../src/components/dress-code-render";

describe("truncateSwatchName", () => {
  it("returns short names unchanged", () => {
    expect(truncateSwatchName("Champagne")).toBe("Champagne");
    expect(truncateSwatchName("Marigold Saffron")).toBe("Marigold Saffron");
  });

  it("trims surrounding whitespace", () => {
    expect(truncateSwatchName("   Gold   ")).toBe("Gold");
  });

  it("truncates names longer than 40 chars with an ellipsis", () => {
    const long = "A".repeat(200);
    const out = truncateSwatchName(long);
    expect(out.length).toBe(40);
    expect(out.endsWith("…")).toBe(true);
  });

  it("returns empty string for non-string input", () => {
    // @ts-expect-error — runtime guard
    expect(truncateSwatchName(undefined)).toBe("");
    // @ts-expect-error
    expect(truncateSwatchName(null)).toBe("");
  });
});
