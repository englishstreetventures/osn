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
}

export type ThemeSection = "hero" | "story" | "details";

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
