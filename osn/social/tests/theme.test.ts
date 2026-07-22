// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { resolveTheme } from "../src/lib/theme";

const originalMatchMedia = window.matchMedia;

/** Stub prefers-color-scheme: light → matches, otherwise no. resolveTheme reads
 *  `window.matchMedia`, so stub that specifically. */
function stubPrefersLight(prefersLight: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: query.includes("light") ? prefersLight : !prefersLight,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal MQL stub
  })) as any;
}

afterEach(() => {
  window.matchMedia = originalMatchMedia;
});

describe("resolveTheme — system default, dark fallback, light only on an explicit light signal", () => {
  it("honours an explicit light preference", () => {
    stubPrefersLight(false);
    expect(resolveTheme("light")).toBe("light");
  });

  it("honours an explicit dark preference", () => {
    stubPrefersLight(true);
    expect(resolveTheme("dark")).toBe("dark");
  });

  it("system follows the OS when the OS asks for light", () => {
    stubPrefersLight(true);
    expect(resolveTheme("system")).toBe("light");
  });

  it("system falls back to dark when the OS asks for dark", () => {
    stubPrefersLight(false);
    expect(resolveTheme("system")).toBe("dark");
  });

  it("system falls back to dark when there is no light signal", () => {
    // prefers-color-scheme: light does not match → dark
    stubPrefersLight(false);
    expect(resolveTheme("system")).toBe("dark");
  });
});
