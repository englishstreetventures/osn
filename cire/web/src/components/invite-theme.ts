import { isValidColor } from "./dress-code-render";

/**
 * The per-section theme an organiser can set in the builder, as it arrives from
 * the public invite endpoint. Every field is nullable — `null` means "use the
 * built-in default token", so an un-themed invite renders exactly as before.
 * Mirrors `InviteTheme` in `cire/api/src/services/invite.ts`.
 */
export interface InviteTheme {
  headingFont: string | null;
  bodyFont: string | null;
  hero: { accentColor: string | null; surfaceColor: string | null };
  story: { accentColor: string | null; surfaceColor: string | null };
  details: { accentColor: string | null; surfaceColor: string | null };
  // "Welcome" — the invite-code entry form + post-claim welcome banner. Optional
  // on the wire only until cire-api ships migration 0027; a payload without it
  // simply keeps the built-in tokens (sectionThemeVars already tolerates a
  // missing section).
  welcome?: { accentColor: string | null; surfaceColor: string | null };
}

export type ThemeSection = "hero" | "story" | "details" | "welcome";

/**
 * Closed map of font-choice key → concrete CSS `font-family` stack. The key is
 * the only thing that ever crosses the wire / is persisted; the guest site owns
 * the stack. NO new web-font is introduced: Cormorant Garamond + Lato are already
 * loaded by `index.astro`, everything else is a pure system stack (zero network
 * cost, no CSS-injection surface). An unknown key (or `null` / `"default"`) falls
 * through to the built-in token, so a stale/garbage value can never break layout.
 */
const FONT_STACKS: Record<string, string> = {
  cormorant: '"Cormorant Garamond", Georgia, serif',
  lato: '"Lato", system-ui, sans-serif',
  georgia: 'Georgia, "Times New Roman", serif',
  "system-sans": 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  "system-mono": 'ui-monospace, "SF Mono", "Cascadia Code", Menlo, monospace',
};

/** Resolve a font-choice key to its CSS stack, or `null` to keep the default. */
export function fontStack(choice: string | null): string | null {
  if (!choice || choice === "default") return null;
  return FONT_STACKS[choice] ?? null;
}

/**
 * Build the inline CSS-variable style map a section wrapper applies. Only emits a
 * variable for a field that is present AND passes validation — fonts must resolve
 * to a known stack, colours must pass the same strict allow-list the dress-code
 * palette uses (defence in depth: the API already validated on write, but the
 * guest site never trusts a colour string into a `style` unchecked). An empty map
 * means "fully default" — the section inherits the global tokens unchanged.
 *
 * Returned keys are CSS custom properties the section's classes consume:
 *   --invite-accent   → the gold/accent colour for that section
 *   --invite-surface  → the section background
 *   --invite-heading  → display/heading font-family
 *   --invite-body     → body font-family
 */
export function sectionThemeVars(
  theme: InviteTheme | null | undefined,
  section: ThemeSection,
): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!theme) return vars;

  const heading = fontStack(theme.headingFont);
  if (heading) vars["--invite-heading"] = heading;
  const body = fontStack(theme.bodyFont);
  if (body) vars["--invite-body"] = body;

  // Defensive: a truthy-but-partial theme (the requested section's sub-object
  // missing — e.g. a mid-deploy payload-shape mismatch on the no-store
  // revalidation, or future shape drift) must NEVER throw here. This map styles
  // the guest invite's events ("details") section wrapper, so a throw would crash
  // the InvitePage island and make the EVENTS list disappear entirely. Mirror the
  // organiser preview helper's `?? default` resilience (`invite-theme-preview.ts`)
  // and simply omit the section colours, falling back to the built-in tokens.
  const sectionColors = theme[section] as
    | { accentColor: string | null; surfaceColor: string | null }
    | undefined;
  const accentColor = sectionColors?.accentColor ?? null;
  const surfaceColor = sectionColors?.surfaceColor ?? null;
  if (accentColor && isValidColor(accentColor)) vars["--invite-accent"] = accentColor;
  if (surfaceColor && isValidColor(surfaceColor)) vars["--invite-surface"] = surfaceColor;

  return vars;
}

/**
 * Scoped token bridge: re-points the global design tokens the Tailwind utility
 * classes consume (`text-gold`, `bg-gold/5`, `hover:border-gold-dim`,
 * `font-display`, `font-body`, `bg-surface`, …) at the validated `--invite-*`
 * variables, so applying this map to a section (or modal) wrapper themes EVERY
 * descendant — including hover/focus/selected states and opacity-modified
 * utilities, which per-element inline styles cannot reach.
 *
 * Each fallback is the built-in token's literal value (a self-reference like
 * `--color-gold: var(--invite-accent, var(--color-gold))` would be a var()
 * cycle, which CSS resolves to *invalid* — not the outer value), so an
 * un-themed invite renders exactly as before. Must stay in sync with the
 * `@theme` tokens in `styles/global.css`.
 */
const TOKEN_BRIDGE: Record<string, string> = {
  "--color-gold": "var(--invite-accent, oklch(74.99% 0.0854 82.08))",
  // The original gold-dim is gold at 0.35 alpha; color-mix reproduces that for
  // any picked accent (and collapses to the same value for the default).
  "--color-gold-dim":
    "color-mix(in oklab, var(--invite-accent, oklch(74.99% 0.0854 82.08)) 35%, transparent)",
  "--color-surface": "var(--invite-surface, oklch(22.7% 0.0275 152.78))",
  "--font-display": 'var(--invite-heading, "Cormorant Garamond", Georgia, serif)',
  "--font-body": 'var(--invite-body, "Lato", system-ui, sans-serif)',
};

/**
 * A section's `--invite-*` variables PLUS the token bridge above, as one style
 * map for the section wrapper. This is what makes a themed accent reach the
 * event cards' buttons, date lines and modal contents rather than just the
 * elements that carry a hand-written inline `var(--invite-…)` style.
 */
export function sectionTokenBridge(
  theme: InviteTheme | null | undefined,
  section: ThemeSection,
): Record<string, string> {
  return { ...sectionThemeVars(theme, section), ...TOKEN_BRIDGE };
}

/**
 * The only style keys a theme-vars map may carry: the four validated
 * `--invite-*` variables plus the fixed bridge tokens. Components that spread a
 * theme map into a `style` attribute (AnimatedModal) filter through this set,
 * so a future caller wiring unvalidated data into the prop can never smuggle an
 * arbitrary CSS property (e.g. `background-image`) into the DOM — the sink
 * enforces the contract instead of relying on every caller remembering it
 * (S-L1).
 */
const ALLOWED_THEME_VAR_KEYS: ReadonlySet<string> = new Set([
  "--invite-accent",
  "--invite-surface",
  "--invite-heading",
  "--invite-body",
  ...Object.keys(TOKEN_BRIDGE),
]);

/** Drop any key outside the theme-variable allow-list (undefined stays undefined). */
export function filterThemeVars(
  vars: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!vars) return undefined;
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(vars)) {
    if (ALLOWED_THEME_VAR_KEYS.has(key)) safe[key] = value;
  }
  return safe;
}
