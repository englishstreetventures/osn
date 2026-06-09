import { describe, it, expect } from "vitest";
import { isValidColor, truncateSwatchName } from "./dress-code-render";

describe("isValidColor", () => {
  it.each([
    "#fff",
    "#FFFF",
    "#ffffff",
    "#ffffffff",
    "#0a0a0a",
    "rgb(255, 0, 0)",
    "rgba(255, 0, 0, 0.5)",
    "hsl(120, 100%, 50%)",
    "hsla(120, 100%, 50%, 0.5)",
    "oklch(76.36% 0.1533 75.16)",
    "oklch(74.99% 0.0854 82.08)",
  ])("accepts %s", (color) => {
    expect(isValidColor(color)).toBe(true);
  });

  it("trims surrounding whitespace before validating", () => {
    expect(isValidColor("  #fff  ")).toBe(true);
  });

  it.each([
    "expression(alert(1))",
    "url(https://evil.example/x.png)",
    "javascript:alert(1)",
    "var(--colour)",
    "red",
    "rebeccapurple",
    "transparent",
    "currentColor",
    "",
    "   ",
    "#",
    "#gg",
    "#ff",
    "#fffffffff", // 9 hex chars
    "rgb 255 0 0",
    "oklch 50% 0 0",
    "rgb(0,0,0); background: url(x)",
    "rgb(0,0,0)/**/expression(alert(1))",
    'rgb(0,0,0,",}',
    "rgb(0\n0\n0)",
    "rgb('0','0','0')",
    "rgb(0;0;0)",
    "rgb(0,0,0)!important",
  ])("rejects %s", (color) => {
    expect(isValidColor(color)).toBe(false);
  });

  it("rejects strings longer than 64 characters", () => {
    expect(isValidColor(`oklch(${"9".repeat(80)})`)).toBe(false);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — guard exercises runtime path
    expect(isValidColor(undefined)).toBe(false);
    // @ts-expect-error
    expect(isValidColor(null)).toBe(false);
    // @ts-expect-error
    expect(isValidColor(123)).toBe(false);
  });
});

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
