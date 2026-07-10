import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, it, expect } from "vitest";

import {
  filterThemeVars,
  fontStack,
  sectionThemeVars,
  sectionTokenBridge,
  type InviteTheme,
} from "./invite-theme";

const fullTheme: InviteTheme = {
  headingFont: "cormorant",
  bodyFont: "system-sans",
  hero: { accentColor: "#d4af37", surfaceColor: "oklch(22.7% 0.0275 152.78)" },
  story: { accentColor: "rgb(212, 175, 55)", surfaceColor: null },
  details: { accentColor: null, surfaceColor: null },
  welcome: { accentColor: "#7a9e7e", surfaceColor: "oklch(30% 0.02 150)" },
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

  it("emits accent + surface for the welcome section (code entry + welcome banner)", () => {
    const vars = sectionThemeVars(fullTheme, "welcome");
    expect(vars["--invite-accent"]).toBe("#7a9e7e");
    expect(vars["--invite-surface"]).toBe("oklch(30% 0.02 150)");
  });

  it("keeps the defaults when a payload predates the welcome section (no `welcome` key)", () => {
    // A cached/mid-deploy invite payload without `welcome` must render the code
    // entry + welcome banner exactly as before — no throw, no stray variables.
    const preWelcome = {
      headingFont: null,
      bodyFont: null,
      hero: { accentColor: "#d4af37", surfaceColor: null },
      story: { accentColor: null, surfaceColor: null },
      details: { accentColor: null, surfaceColor: null },
    } as InviteTheme;
    expect(sectionThemeVars(preWelcome, "welcome")).toEqual({});
  });

  it("returns an empty map for a null theme (fully default)", () => {
    expect(sectionThemeVars(null, "hero")).toEqual({});
    expect(sectionThemeVars(undefined, "story")).toEqual({});
  });

  it("never throws on a truthy-but-partial theme (the section sub-object missing)", () => {
    // Regression: a malformed/partial theme payload (a missing section — e.g. a
    // mid-deploy shape mismatch on the guest invite's no-store revalidation) must
    // NOT throw. This map styles the events ("details") section wrapper, and a
    // throw here would crash the InvitePage island and make the events vanish.
    const partial = {
      headingFont: "cormorant",
      bodyFont: null,
      hero: { accentColor: "#d4af37", surfaceColor: null },
      // `story` + `details` deliberately absent — an out-of-contract payload.
    } as unknown as InviteTheme;

    expect(() => sectionThemeVars(partial, "details")).not.toThrow();
    const vars = sectionThemeVars(partial, "details");
    // No section colours (fall back to the built-in tokens), but the global font
    // still applies — exactly as a section with both colours null would render.
    expect(vars["--invite-accent"]).toBeUndefined();
    expect(vars["--invite-surface"]).toBeUndefined();
    expect(vars["--invite-heading"]).toContain("Cormorant Garamond");
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

describe("sectionTokenBridge", () => {
  it("includes the section's --invite-* vars plus the re-pointed global tokens", () => {
    const vars = sectionTokenBridge(fullTheme, "hero");
    // The section vars are still present…
    expect(vars["--invite-accent"]).toBe("#d4af37");
    // …and the bridge re-points every themed global token at them, so utility
    // classes (`text-gold`, `font-display`, `bg-surface`, …) inside the section
    // resolve the organiser's theme too.
    expect(vars["--color-gold"]).toBe("var(--invite-accent, oklch(74.99% 0.0854 82.08))");
    expect(vars["--color-gold-dim"]).toContain("color-mix");
    expect(vars["--color-surface"]).toBe("var(--invite-surface, oklch(22.7% 0.0275 152.78))");
    expect(vars["--font-display"]).toContain("var(--invite-heading");
    expect(vars["--font-body"]).toContain("var(--invite-body");
  });

  it("still emits the bridge for an un-themed invite (fallbacks reproduce the built-ins)", () => {
    // With no --invite-* vars set, each bridged token resolves its literal
    // fallback — the original token value — so an un-themed invite is unchanged.
    const vars = sectionTokenBridge(null, "details");
    expect(vars["--invite-accent"]).toBeUndefined();
    expect(vars["--color-gold"]).toContain("oklch(74.99% 0.0854 82.08)");
    expect(vars["--font-display"]).toContain("Cormorant Garamond");
  });

  it("never uses a self-referencing var() fallback (that would resolve to invalid, not the outer value)", () => {
    for (const [name, value] of Object.entries(sectionTokenBridge(fullTheme, "details"))) {
      expect(value, `${name} must not reference itself`).not.toContain(`var(${name}`);
    }
  });

  it("stays in lockstep with the @theme tokens in styles/global.css (T-S1)", () => {
    // The bridge's fallbacks are hand-copied literals of the global tokens (a
    // self-referencing var() would be a cycle). If a designer retunes a token in
    // global.css without updating the bridge, every UN-themed invite would
    // silently render the stale colour inside bridged sections/modals only — a
    // split-token bug no behavioural test can catch. Enforce the comment-only
    // contract mechanically, same spirit as cire/api's ddl-lockstep test.
    // vitest runs with the package root as cwd; import.meta.url is not a
    // file: URL under this transform, so resolve from cwd instead.
    const css = readFileSync(resolve(process.cwd(), "src/styles/global.css"), "utf8");
    const token = (name: string): string => {
      const match = css.match(new RegExp(`${name}:\\s*([^;]+);`));
      expect(match, `${name} must exist in global.css @theme`).not.toBeNull();
      return match![1].trim();
    };

    const bridge = sectionTokenBridge(null, "hero");
    expect(bridge["--color-gold"]).toContain(token("--color-gold"));
    expect(bridge["--color-gold-dim"]).toContain(token("--color-gold"));
    expect(bridge["--color-surface"]).toContain(token("--color-surface"));
    expect(bridge["--font-display"]).toContain(token("--font-display"));
    expect(bridge["--font-body"]).toContain(token("--font-body"));
  });
});

describe("filterThemeVars", () => {
  it("passes through the full bridge map unchanged", () => {
    const bridge = sectionTokenBridge(fullTheme, "details");
    expect(filterThemeVars(bridge)).toEqual(bridge);
  });

  it("drops keys outside the theme-variable allow-list (the style-sink gate)", () => {
    const filtered = filterThemeVars({
      "--invite-accent": "#abcdef",
      "background-image": "url(https://evil.example/x)",
      color: "red",
      "--not-a-theme-var": "x",
    });
    expect(filtered).toEqual({ "--invite-accent": "#abcdef" });
  });

  it("keeps undefined as undefined (absent prop stays absent)", () => {
    expect(filterThemeVars(undefined)).toBeUndefined();
  });
});
