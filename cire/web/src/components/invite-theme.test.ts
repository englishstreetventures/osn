import { describe, it, expect } from "vitest";

import { fontStack, sectionThemeVars, type InviteTheme } from "./invite-theme";

const fullTheme: InviteTheme = {
  headingFont: "cormorant",
  bodyFont: "system-sans",
  hero: { accentColor: "#d4af37", surfaceColor: "oklch(22.7% 0.0275 152.78)" },
  story: { accentColor: "rgb(212, 175, 55)", surfaceColor: null },
  details: { accentColor: null, surfaceColor: null },
};

describe("fontStack", () => {
  it("maps a known font key to a concrete stack", () => {
    expect(fontStack("cormorant")).toContain("Cormorant Garamond");
    expect(fontStack("system-mono")).toContain("monospace");
  });

  it.each([null, "default", "unknown-font", "../../etc/passwd"])(
    "returns null for %s (keep the built-in default, never inject a stray value)",
    (choice) => {
      expect(fontStack(choice)).toBeNull();
    },
  );
});

describe("sectionThemeVars", () => {
  it("emits accent + surface + fonts for a fully-themed section", () => {
    const vars = sectionThemeVars(fullTheme, "hero");
    expect(vars["--invite-accent"]).toBe("#d4af37");
    expect(vars["--invite-surface"]).toBe("oklch(22.7% 0.0275 152.78)");
    expect(vars["--invite-heading"]).toContain("Cormorant Garamond");
    expect(vars["--invite-body"]).toContain("system-ui");
  });

  it("omits a colour variable when the field is null (falls back to default token)", () => {
    const vars = sectionThemeVars(fullTheme, "details");
    expect(vars["--invite-accent"]).toBeUndefined();
    expect(vars["--invite-surface"]).toBeUndefined();
    // Global fonts still apply to every section.
    expect(vars["--invite-heading"]).toContain("Cormorant Garamond");
  });

  it("returns an empty map for a null theme (fully default)", () => {
    expect(sectionThemeVars(null, "hero")).toEqual({});
    expect(sectionThemeVars(undefined, "story")).toEqual({});
  });

  it("drops a colour that fails the allow-list (defence in depth at the render boundary)", () => {
    const malicious: InviteTheme = {
      ...fullTheme,
      hero: {
        accentColor: "red; background:url(https://evil.example/x)",
        surfaceColor: "rebeccapurple",
      },
    };
    const vars = sectionThemeVars(malicious, "hero");
    expect(vars["--invite-accent"]).toBeUndefined();
    expect(vars["--invite-surface"]).toBeUndefined();
  });

  it("drops an empty-string or over-long colour (boundary guards)", () => {
    const overLong = `rgb(${" ".repeat(80)}0, 0, 0)`;
    const theme: InviteTheme = {
      ...fullTheme,
      hero: { accentColor: "", surfaceColor: overLong },
    };
    const vars = sectionThemeVars(theme, "hero");
    expect(vars["--invite-accent"]).toBeUndefined();
    expect(vars["--invite-surface"]).toBeUndefined();
  });
});
