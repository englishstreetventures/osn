import { describe, it, expect } from "bun:test";

import { isSafeCssColor } from "./index";

/**
 * Direct behavioural pin for the single source of truth (IB-S-L1). The
 * consumer suites (`cire/web` dress-code-render, `cire/api` invite 400s)
 * verify only the re-export plumbing; this file keeps the validator
 * self-verifying even if a consumer's wiring changes.
 */
describe("isSafeCssColor", () => {
  const accepted = [
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
  ];
  for (const color of accepted) {
    it(`accepts ${color}`, () => {
      expect(isSafeCssColor(color)).toBe(true);
    });
  }

  it("trims surrounding whitespace before validating", () => {
    expect(isSafeCssColor("  #fff  ")).toBe(true);
  });

  const rejected = [
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
  ];
  for (const color of rejected) {
    it(`rejects ${JSON.stringify(color)}`, () => {
      expect(isSafeCssColor(color)).toBe(false);
    });
  }

  it("rejects strings longer than 64 characters", () => {
    expect(isSafeCssColor(`oklch(${"9".repeat(80)})`)).toBe(false);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error — guard exercises the runtime path
    expect(isSafeCssColor(undefined)).toBe(false);
    // @ts-expect-error
    expect(isSafeCssColor(null)).toBe(false);
    // @ts-expect-error
    expect(isSafeCssColor(123)).toBe(false);
  });
});
