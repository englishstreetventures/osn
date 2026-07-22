import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { derivePalette, PALETTE_PRESETS } from "@cire/theme";
import { describe, expect, it } from "vitest";

import {
  applyPaletteToRoot,
  filterThemeVars,
  type InviteTheme,
  paletteRootVars,
  sectionVars,
  styleAttr,
} from "./invite-theme";

const themed: InviteTheme = {
  headingFont: "cormorant",
  bodyFont: "system-sans",
  palettePreset: "jewel",
  palette: PALETTE_PRESETS.jewel,
  tones: { hero: "ground", story: "card", details: "raised", welcome: null },
};

describe("paletteRootVars", () => {
  it("derives the whole token set from the five seeds", () => {
    const vars = paletteRootVars(themed);
    // The colour half is exactly what @cire/theme derives — the guest site adds
    // no colour maths of its own, so the organiser's preview cannot disagree.
    for (const [token, value] of Object.entries(derivePalette(PALETTE_PRESETS.jewel))) {
      expect({ token, value: vars[token] }).toEqual({ token, value });
    }
  });

  it("covers the tokens the old per-section bridge could not reach", () => {
    const vars = paletteRootVars(themed);
    // These were hard-locked before: an organiser could pick eight colours and
    // still not change the page background, borders, or body text.
    for (const token of ["--color-bg", "--color-border", "--color-text", "--color-text-muted"]) {
      expect(typeof vars[token]).toBe("string");
      expect(vars[token]).not.toBe("");
    }
  });

  it("resolves fonts through the closed allow-list", () => {
    const vars = paletteRootVars(themed);
    expect(vars["--font-display"]).toContain("Cormorant Garamond");
    expect(vars["--font-body"]).toContain("system-ui");
    // Tailwind's default family must follow the body face, or unclassed text
    // keeps the built-in one and the page reads as two typefaces.
    expect(vars["--default-font-family"]).toBe(vars["--font-body"]);
  });

  it("omits the font variables for an unknown or default choice", () => {
    for (const choice of [null, "default", "unknown-font", "../../etc/passwd"]) {
      const vars = paletteRootVars({ ...themed, headingFont: choice, bodyFont: choice });
      expect(vars["--font-display"]).toBeUndefined();
      expect(vars["--font-body"]).toBeUndefined();
      expect(vars["--default-font-family"]).toBeUndefined();
    }
  });

  it("renders a chosen preset when the organiser edited no seed", () => {
    // Caught on a live preview: the API returns `palettePreset: "chapel"` with
    // five null seeds, and the guest rendered evergreen.
    const vars = paletteRootVars({
      headingFont: null,
      bodyFont: null,
      palettePreset: "chapel",
      palette: { ground: null, card: null, ink: null, gilt: null, bloom: null },
    });
    expect(vars["--color-bg"]).toBe(derivePalette(PALETTE_PRESETS.chapel)["--color-bg"]);
    expect(vars["--color-gold"]).toBe(derivePalette(PALETTE_PRESETS.chapel)["--color-gold"]);
  });

  it("ignores an unrecognised preset key (stale value degrades to the built-in)", () => {
    const vars = paletteRootVars({
      headingFont: null,
      bodyFont: null,
      palettePreset: "some-removed-preset",
      palette: null,
    });
    expect(vars).toEqual(derivePalette(PALETTE_PRESETS.evergreen));
  });

  it("renders the built-in scheme for a null theme", () => {
    expect(paletteRootVars(null)).toEqual(derivePalette(PALETTE_PRESETS.evergreen));
    expect(paletteRootVars(undefined)).toEqual(derivePalette(PALETTE_PRESETS.evergreen));
  });

  it("drops a seed that fails the allow-list (defence in depth at the render boundary)", () => {
    // The API rejects these on write; this is the second half of the same gate.
    const malicious: InviteTheme = {
      headingFont: null,
      bodyFont: null,
      palette: {
        ground: "red; background:url(https://evil.example/x)",
        card: "rebeccapurple",
        ink: "javascript:alert(1)",
        gilt: `rgb(${" ".repeat(80)}0, 0, 0)`,
        bloom: "",
      },
    };
    // Every seed is rejected, so the whole scheme falls back to the built-in —
    // a corrupt value degrades to the default look, never to broken CSS.
    expect(paletteRootVars(malicious)).toEqual(derivePalette(PALETTE_PRESETS.evergreen));
  });

  it("never emits a value carrying a CSS declaration terminator", () => {
    for (const value of Object.values(paletteRootVars(themed))) {
      expect(value).not.toMatch(/[;<>]/);
    }
  });

  it("never throws on a truthy-but-partial theme (shape drift mid-deploy)", () => {
    // This map styles the guest's EVENTS section; a throw here would crash the
    // island and make the events disappear entirely.
    const partial = { headingFont: "cormorant" } as InviteTheme;
    expect(() => paletteRootVars(partial)).not.toThrow();
    expect(paletteRootVars(partial)["--color-bg"]).toBeDefined();
  });
});

describe("sectionVars", () => {
  it("maps each section's tone to the surface it sits on", () => {
    expect(sectionVars(themed, "hero")).toEqual({ "--invite-section-bg": "var(--color-bg)" });
    expect(sectionVars(themed, "story")).toEqual({ "--invite-section-bg": "var(--color-surface)" });
    expect(sectionVars(themed, "details")).toEqual({
      "--invite-section-bg": "var(--color-surface-raised)",
    });
  });

  it("falls back to the page ground for a null tone, theme, or payload", () => {
    const ground = { "--invite-section-bg": "var(--color-bg)" };
    expect(sectionVars(themed, "welcome")).toEqual(ground);
    expect(sectionVars(null, "details")).toEqual(ground);
    expect(sectionVars({ headingFont: null, bodyFont: null }, "story")).toEqual(ground);
  });

  it("never throws on a garbage tone (the events section must always render)", () => {
    const junk = { headingFont: null, bodyFont: null, tones: { details: "url(evil)" } } as never;
    expect(() => sectionVars(junk, "details")).not.toThrow();
    expect(sectionVars(junk, "details")).toEqual({ "--invite-section-bg": "var(--color-bg)" });
  });
});

describe("global.css lockstep (T-S1)", () => {
  it("declares every derived token, so an un-themed invite has a fallback", () => {
    // The palette overrides these at the root; global.css is what paints when
    // no scheme is set. A token derived here but missing there would render as
    // an empty custom property on an un-themed invite.
    const css = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");
    for (const token of Object.keys(derivePalette(PALETTE_PRESETS.evergreen))) {
      expect(css).toContain(`${token}:`);
    }
  });

  it("keeps the built-in scheme identical to the evergreen preset's own tokens", () => {
    // `evergreen` IS today's look, spelled out in `@cire/theme`. If someone
    // retunes a token in global.css without updating the preset, an un-themed
    // invite and an explicitly-evergreen one would drift apart.
    const css = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");
    const token = (name: string): string => {
      const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
      expect(match, `${name} must exist in global.css`).not.toBeNull();
      return match![1].trim();
    };
    const derived = derivePalette(PALETTE_PRESETS.evergreen);
    for (const name of ["--color-bg", "--color-surface", "--color-gold", "--color-text"]) {
      expect({ name, value: token(name) }).toEqual({ name, value: derived[name] as string });
    }
  });
});

describe("filterThemeVars", () => {
  it("passes through the full palette map unchanged", () => {
    const vars = paletteRootVars(themed);
    expect(filterThemeVars(vars)).toEqual(vars);
  });

  it("passes through a section tone map unchanged", () => {
    const vars = sectionVars(themed, "story");
    expect(filterThemeVars(vars)).toEqual(vars);
  });

  it("drops keys outside the theme-variable allow-list (the style-sink gate)", () => {
    const filtered = filterThemeVars({
      "--color-gold": "#abcdef",
      "background-image": "url(https://evil.example/x)",
      color: "red",
      "--not-a-theme-var": "x",
    });
    expect(filtered).toEqual({ "--color-gold": "#abcdef" });
  });

  it("keeps undefined as undefined (absent prop stays absent)", () => {
    expect(filterThemeVars(undefined)).toBeUndefined();
  });
});

describe("styleAttr", () => {
  it("serialises the palette into a style attribute the Astro shell can inline", () => {
    const attr = styleAttr(paletteRootVars(themed));
    expect(attr).toContain("--color-bg:");
    expect(attr).toContain("--color-gold:");
    expect(attr.split(";").length).toBeGreaterThan(10);
  });

  it("carries the FONT declarations too (they contain quoted family names)", () => {
    // Regression: an earlier filter rejected `"` as well, which silently dropped
    // every font — a themed invite server-rendered its colours but not its
    // typography, and only picked the fonts up on hydration.
    const attr = styleAttr(paletteRootVars(themed));
    expect(attr).toContain("--font-display:");
    expect(attr).toContain("Cormorant Garamond");
    expect(attr).toContain("--default-font-family:");
  });

  it("drops any value that could open a second declaration (raw-attribute sink)", () => {
    expect(
      styleAttr({
        "--color-gold": "#fff;background-image:url(https://evil.example/x)",
        "--color-bg": "#123456",
      }),
    ).toBe("--color-bg:#123456");
    // A CSS escape sequence must not be able to reconstruct a terminator.
    expect(styleAttr({ "--color-gold": "#fff\\3b x", "--color-bg": "#123456" })).toBe(
      "--color-bg:#123456",
    );
    expect(styleAttr({ "--color-gold": "#fff<script>", "--color-bg": "#123456" })).toBe(
      "--color-bg:#123456",
    );
  });

  it("drops keys outside the allow-list before serialising", () => {
    expect(styleAttr({ "background-image": "url(x)" } as never)).toBe("");
  });
});

describe("applyPaletteToRoot", () => {
  it("writes every derived token onto the document root", () => {
    applyPaletteToRoot(themed);
    const root = document.documentElement;
    const derived = derivePalette(PALETTE_PRESETS.jewel);
    expect(root.style.getPropertyValue("--color-bg")).toBe(derived["--color-bg"]);
    expect(root.style.getPropertyValue("--color-gold")).toBe(derived["--color-gold"]);
    // The footer sits outside every section wrapper — the root is the only
    // place a theme can reach it from.
    expect(root.style.getPropertyValue("--color-text-muted")).toBe(derived["--color-text-muted"]);
  });

  it("repaints when the theme changes (organiser saved a new scheme)", () => {
    applyPaletteToRoot(themed);
    applyPaletteToRoot({ ...themed, palette: PALETTE_PRESETS.fog });
    expect(document.documentElement.style.getPropertyValue("--color-bg")).toBe(
      derivePalette(PALETTE_PRESETS.fog)["--color-bg"],
    );
  });

  it("clears a variable the new theme no longer sets", () => {
    // An organiser clearing their heading font back to the default stops
    // `paletteRootVars` emitting --font-display. Without removal the value from
    // the previous apply (or the SSR shell) would stick forever, and the guest
    // would keep seeing a font the invite no longer specifies.
    applyPaletteToRoot(themed);
    expect(document.documentElement.style.getPropertyValue("--font-display")).toContain(
      "Cormorant Garamond",
    );
    applyPaletteToRoot({ ...themed, headingFont: null });
    expect(document.documentElement.style.getPropertyValue("--font-display")).toBe("");
    // …while the colours it still sets are untouched.
    expect(document.documentElement.style.getPropertyValue("--color-bg")).not.toBe("");
  });
});
