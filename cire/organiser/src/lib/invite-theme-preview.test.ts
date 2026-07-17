/**
 * T-M1 — mirror-contract test for invite-theme-preview.ts.
 *
 * `cire/organiser/src/lib/invite-theme-preview.ts` is a hand-maintained copy
 * of the guest site's theme mapping in
 * `cire/web/src/components/invite-theme.ts`. The header of that file mandates
 * that FONT_STACKS, PREVIEW_DEFAULTS, and per-section default substitution
 * (including the `welcome` section) stay in sync. Nothing in the build
 * currently fails if they drift — the builder preview could silently lie
 * about what guests see.
 *
 * This suite cross-imports from BOTH modules so a future change to either
 * literal breaks CI, not just a code review.
 *
 * The relative path below reaches the guest module through the bun/vitest
 * module resolution: the test runner sets the cwd to the organiser package
 * root, but TypeScript / Vite resolves imports relative to the TEST FILE.
 * From `cire/organiser/src/lib/` → 4 levels up = repo root, then into
 * `cire/web/src/components/invite-theme`.
 * `invite-theme.ts` only imports `@cire/theme` transitively (via
 * `dress-code-render.ts`), which IS in the organiser's node_modules.
 */

import { describe, it, expect } from "vitest";

// Authoritative guest-site module (imported directly so drift breaks CI).
import {
  fontStack as guestFontStack,
  sectionTokenBridge,
  type ThemeSection,
} from "../../../../cire/web/src/components/invite-theme";
// Organiser preview module under test.
import {
  previewFontStack,
  previewSectionVars,
  PREVIEW_DEFAULTS,
  resolveSectionTheme,
  type PreviewTheme,
} from "./invite-theme-preview";

// All keys the FONT_STACKS lookup must support (mirrors both files' closed map).
const FONT_KEYS = ["cormorant", "lato", "georgia", "system-sans", "system-mono"] as const;

// All sections including `welcome` (the one that silently regressed before #120).
const SECTIONS: ThemeSection[] = ["hero", "story", "details", "welcome"];

// A null-colour PreviewTheme so we exercise default substitution on every section.
const nullTheme: PreviewTheme = {
  headingFont: null,
  bodyFont: null,
  accent: { hero: null, story: null, details: null, welcome: null },
  surface: { hero: null, story: null, details: null, welcome: null },
};

// ── Font stacks ──────────────────────────────────────────────────────────────

describe("T-M1 font stacks: organiser preview mirrors guest-site FONT_STACKS", () => {
  it.each(FONT_KEYS)("previewFontStack(%s) === guestFontStack(%s)", (key) => {
    expect(previewFontStack(key)).toBe(guestFontStack(key));
  });

  it.each([null, "default", "unknown-key", ""] as const)(
    "both return null for %s (keep the built-in token)",
    (choice) => {
      expect(previewFontStack(choice)).toBeNull();
      expect(guestFontStack(choice)).toBeNull();
    },
  );
});

// ── PREVIEW_DEFAULTS vs TOKEN_BRIDGE fallbacks ────────────────────────────────
//
// The guest site's TOKEN_BRIDGE is unexported (private constant), but its
// fallback literal values are accessible via sectionTokenBridge(null, section),
// which emits e.g. `--color-gold: var(--invite-accent, oklch(74.99% 0.0854 82.08))`.
// We extract the fallback substring and assert it equals PREVIEW_DEFAULTS.
// If either side changes its literal, this breaks CI.

describe("T-M1 PREVIEW_DEFAULTS: organiser preview defaults match guest-site TOKEN_BRIDGE fallbacks", () => {
  it("accent default matches --color-gold fallback in TOKEN_BRIDGE", () => {
    // sectionTokenBridge(null, …) always emits the bridge (no section vars for null theme).
    const bridge = sectionTokenBridge(null, "hero");
    // e.g. "var(--invite-accent, oklch(74.99% 0.0854 82.08))"
    expect(bridge["--color-gold"]).toContain(PREVIEW_DEFAULTS.accent);
  });

  it("surface default matches --color-surface fallback in TOKEN_BRIDGE", () => {
    const bridge = sectionTokenBridge(null, "hero");
    expect(bridge["--color-surface"]).toContain(PREVIEW_DEFAULTS.surface);
  });

  it("heading default matches --font-display fallback in TOKEN_BRIDGE", () => {
    const bridge = sectionTokenBridge(null, "hero");
    expect(bridge["--font-display"]).toContain(PREVIEW_DEFAULTS.heading);
  });

  it("body default matches --font-body fallback in TOKEN_BRIDGE", () => {
    const bridge = sectionTokenBridge(null, "hero");
    expect(bridge["--font-body"]).toContain(PREVIEW_DEFAULTS.body);
  });
});

// ── Per-section default substitution ─────────────────────────────────────────
//
// When an organiser has not set any colour for a section, the preview must
// produce the same concrete values as the guest site's TOKEN_BRIDGE fallbacks.
// Covers every section including `welcome`.

describe("T-M1 per-section defaults: previewSectionVars matches guest TOKEN_BRIDGE fallbacks for all sections", () => {
  it.each(SECTIONS)("section %s — accent default is the same literal on both sides", (section) => {
    const previewVars = previewSectionVars(nullTheme, section);
    const bridge = sectionTokenBridge(null, section);
    // Preview always emits a concrete value; guest TOKEN_BRIDGE emits a var(…) expression
    // whose fallback is the same literal.
    expect(bridge["--color-gold"]).toContain(previewVars["--invite-accent"]);
  });

  it.each(SECTIONS)("section %s — surface default is the same literal on both sides", (section) => {
    const previewVars = previewSectionVars(nullTheme, section);
    const bridge = sectionTokenBridge(null, section);
    expect(bridge["--color-surface"]).toContain(previewVars["--invite-surface"]);
  });

  it.each(SECTIONS)("section %s — heading default is the same literal on both sides", (section) => {
    const previewVars = previewSectionVars(nullTheme, section);
    const bridge = sectionTokenBridge(null, section);
    expect(bridge["--font-display"]).toContain(previewVars["--invite-heading"]);
  });

  it.each(SECTIONS)("section %s — body default is the same literal on both sides", (section) => {
    const previewVars = previewSectionVars(nullTheme, section);
    const bridge = sectionTokenBridge(null, section);
    expect(bridge["--font-body"]).toContain(previewVars["--invite-body"]);
  });
});

// ── welcome section explicitly covered ───────────────────────────────────────
//
// The `welcome` section (invite-code entry + post-claim banner) was the one
// that silently drifted before #120 added it to the organiser preview.
// Pin it explicitly so a future removal is caught even before the
// parameterised tests above fire.

describe("T-M1 welcome section: resolveSectionTheme is faithful for the welcome section", () => {
  it("resolves to the same accent default as the TOKEN_BRIDGE --color-gold fallback", () => {
    const resolved = resolveSectionTheme(nullTheme, "welcome");
    const bridge = sectionTokenBridge(null, "welcome");
    expect(bridge["--color-gold"]).toContain(resolved.accent);
  });

  it("resolves to the same surface default as the TOKEN_BRIDGE --color-surface fallback", () => {
    const resolved = resolveSectionTheme(nullTheme, "welcome");
    const bridge = sectionTokenBridge(null, "welcome");
    expect(bridge["--color-surface"]).toContain(resolved.surface);
  });

  it("resolves to the same heading default as the TOKEN_BRIDGE --font-display fallback", () => {
    const resolved = resolveSectionTheme(nullTheme, "welcome");
    const bridge = sectionTokenBridge(null, "welcome");
    expect(bridge["--font-display"]).toContain(resolved.heading);
  });

  it("resolves to the same body default as the TOKEN_BRIDGE --font-body fallback", () => {
    const resolved = resolveSectionTheme(nullTheme, "welcome");
    const bridge = sectionTokenBridge(null, "welcome");
    expect(bridge["--font-body"]).toContain(resolved.body);
  });
});
