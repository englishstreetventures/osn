/**
 * LOCAL mirror of the guest site's theme → CSS-variable mapping, for the live
 * preview in the invite builder. The authoritative version is `sectionThemeVars`
 * + `fontStack` in `cire/web/src/components/invite-theme.ts`; we cannot import
 * across the `cire/web` ↔ `cire/organiser` package boundary cleanly (and must
 * never pull Effect / web internals into the organiser), so this is a small,
 * deliberately-faithful copy. Keep the var NAMES, the font keys, and the
 * "null ⇒ inherit the default token" precedence in sync with that file so the
 * preview matches what a guest actually sees.
 *
 * The guest invite consumes these via `var(--invite-accent, <default>)` etc., so
 * an unset variable falls through to the built-in token. The preview swatches
 * below replicate those same fallbacks for an honest "before/after".
 */

export type ThemeSection = "hero" | "story" | "details";

/**
 * Font-choice key → CSS `font-family` stack. MUST mirror `FONT_STACKS` in
 * `cire/web/src/components/invite-theme.ts`. An unknown key / `null` / `"default"`
 * returns `null` (keep the built-in token).
 */
const FONT_STACKS: Record<string, string> = {
  cormorant: '"Cormorant Garamond", Georgia, serif',
  lato: '"Lato", system-ui, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  "system-sans": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "system-mono": 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
};

/** Resolve a font-choice key to its CSS stack, or `null` to keep the default. */
export function previewFontStack(choice: string | null): string | null {
  if (!choice || choice === "default") return null;
  return FONT_STACKS[choice] ?? null;
}

/**
 * The built-in default tokens the guest invite falls back to when a section
 * leaves a variable unset (mirrors the `var(--invite-*, <default>)` fallbacks in
 * InviteHeader / InvitePage). Used so the preview is faithful even when a colour
 * is "Default" rather than picked. These are the cire palette's gold / surface /
 * display values.
 */
export const PREVIEW_DEFAULTS = {
  accent: "oklch(74.99% 0.0854 82.08)", // --color-gold
  surface: "oklch(22.7% 0.0275 152.78)", // --color-surface
  heading: '"Cormorant Garamond", Georgia, serif', // --font-display
  body: '"Lato", system-ui, sans-serif', // --font-body
} as const;

export interface PreviewTheme {
  headingFont: string | null;
  bodyFont: string | null;
  accent: Record<ThemeSection, string | null>;
  surface: Record<ThemeSection, string | null>;
}

/**
 * Resolved (default-substituted) preview values for one section. Unlike the guest
 * site — which sets a CSS variable only when present and lets CSS resolve the
 * fallback — the preview computes the concrete value so a plain inline `style`
 * renders correctly without the guest stylesheet's `var(--invite-*, …)` defaults.
 */
export interface ResolvedSectionTheme {
  accent: string;
  surface: string;
  heading: string;
  body: string;
}

/** Resolve a section's live picker values to concrete colours + fonts. */
export function resolveSectionTheme(
  theme: PreviewTheme,
  section: ThemeSection,
): ResolvedSectionTheme {
  return {
    accent: theme.accent[section] ?? PREVIEW_DEFAULTS.accent,
    surface: theme.surface[section] ?? PREVIEW_DEFAULTS.surface,
    heading: previewFontStack(theme.headingFont) ?? PREVIEW_DEFAULTS.heading,
    body: previewFontStack(theme.bodyFont) ?? PREVIEW_DEFAULTS.body,
  };
}

/**
 * Build the inline CSS-variable style map for a preview section, mirroring the
 * guest var NAMES (`--invite-accent` / `--invite-surface` / `--invite-heading` /
 * `--invite-body`). The preview elements consume these via the same
 * `var(--invite-*)` references the guest invite uses, so the wiring is faithful.
 * Defaults are substituted here (see {@link resolveSectionTheme}) so the preview
 * renders without the guest stylesheet.
 */
export function previewSectionVars(
  theme: PreviewTheme,
  section: ThemeSection,
): Record<string, string> {
  const r = resolveSectionTheme(theme, section);
  return {
    "--invite-accent": r.accent,
    "--invite-surface": r.surface,
    "--invite-heading": r.heading,
    "--invite-body": r.body,
  };
}
