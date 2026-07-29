// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import { resolveTheme, setThemePref } from "../src/lib/theme";

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

describe("setThemePref — theme-color meta sync", () => {
  // The hex values must stay pinned to the static metas in index.html; a
  // drift leaves iOS Safari chrome mismatching the app on a forced theme.
  it("collapses every theme-color meta to the resolved theme's colour", () => {
    stubPrefersLight(false);
    const metas = [document.createElement("meta"), document.createElement("meta")];
    for (const meta of metas) {
      meta.setAttribute("name", "theme-color");
      document.head.appendChild(meta);
    }
    try {
      setThemePref("dark");
      expect(metas.map((m) => m.getAttribute("content"))).toEqual(["#1c1c1c", "#1c1c1c"]);
      setThemePref("light");
      expect(metas.map((m) => m.getAttribute("content"))).toEqual(["#ffffff", "#ffffff"]);
    } finally {
      for (const meta of metas) meta.remove();
      setThemePref("system");
    }
  });
});
