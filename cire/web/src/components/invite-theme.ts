import {
  DERIVED_TOKENS,
  derivePalette,
  fontStack,
  isPalettePresetKey,
  type PaletteSeeds,
  type SectionTone,
  sectionToneVars,
} from "@cire/theme";

import { isValidColor } from "./dress-code-render";

/**
 * The invite theme as it arrives from the public invite endpoint. Mirrors
 * `InviteTheme` in `cire/api/src/services/invite.ts`.
 *
 * Colour is a five-seed SCHEME, not eight per-section colours: `derivePalette`
 * turns the seeds into the whole token set once, at the document root, so the
 * organiser's colours reach every section, every modal, the footer and the hero
 * gradient — instead of the five tokens the old per-section bridge could reach.
 * Section identity comes from `tones` (which derived surface a section sits on).
 *
 * Every field is nullable — `null` means "use the built-in default", so an
 * un-themed invite renders exactly as it always has.
 */
export interface InviteTheme {
  headingFont: string | null;
  bodyFont: string | null;
  palettePreset?: string | null;
  palette?: Partial<Record<keyof PaletteSeeds, string | null>> | null;
  tones?: Partial<Record<ThemeSection, string | null>> | null;
}

export type ThemeSection = "hero" | "story" | "details" | "welcome";

/**
 * Re-validate every seed at render time before it can reach a `style`.
 *
 * The API already rejected un-listed colours on write; this is the second half
 * of the same gate (defence in depth — a drifted validator on either side would
 * let an unvalidated value reach rendered CSS). A seed that fails is dropped,
 * and `derivePalette` resolves a missing seed to the default preset's value for
 * that role — so a corrupt value degrades to the built-in look rather than
 * breaking the page.
 */
function safeSeeds(theme: InviteTheme | null | undefined): Partial<PaletteSeeds> {
  const raw = theme?.palette;
  if (!raw) return {};
  const out: Partial<PaletteSeeds> = {};
  for (const key of ["ground", "card", "ink", "gilt", "bloom"] as const) {
    const value = raw[key];
    if (typeof value === "string" && isValidColor(value)) out[key] = value;
  }
  return out;
}

/**
 * The full derived token set for an invite, as one style map for the document
 * root. This is what makes the organiser's scheme reach EVERY descendant —
 * including hover/focus states and opacity-modified Tailwind utilities, which
 * per-element inline styles cannot reach.
 *
 * Fonts ride along here too: they were always global (one heading face, one
 * body face), so applying them per-section was only ever repeated work.
 */
export function paletteRootVars(theme: InviteTheme | null | undefined): Record<string, string> {
  // The preset is part of what renders, not just a UI memento: an organiser who
  // picks a scheme and changes nothing saves the KEY with five null seeds, and
  // each null falls back to THAT preset's colour for the role. Drop it if it
  // isn't a known key, so a stale value degrades to the built-in scheme.
  const preset = theme?.palettePreset;
  const vars: Record<string, string> = derivePalette(
    safeSeeds(theme),
    typeof preset === "string" && isPalettePresetKey(preset) ? preset : null,
  );

  // Fonts resolve through the same closed allow-list; an unknown/absent key
  // simply keeps the built-in token.
  const heading = fontStack(theme?.headingFont ?? null);
  if (heading) vars["--font-display"] = heading;
  const body = fontStack(theme?.bodyFont ?? null);
  if (body) {
    vars["--font-body"] = body;
    // Tailwind's default family reads this; without it, unclassed text keeps
    // the built-in body face while classed text switches — a split page.
    vars["--default-font-family"] = body;
  }

  return vars;
}

/**
 * The style map a section wrapper applies: which derived surface it sits on.
 * One variable — the section paints `background-color: var(--invite-section-bg)`.
 *
 * A missing/garbage tone falls back to the page ground rather than throwing.
 * This styles the wrapper around the guest's EVENTS list, so a throw here would
 * crash the island and make the events disappear entirely — the failure mode the
 * old per-section helper was hardened against. Keep that property.
 */
export function sectionVars(
  theme: InviteTheme | null | undefined,
  section: ThemeSection,
): Record<string, string> {
  const tone = theme?.tones?.[section] ?? null;
  return sectionToneVars(tone as SectionTone | null);
}

/**
 * The only style keys a theme-vars map may carry: the derived palette tokens,
 * the two font families, Tailwind's default-family variable, and the section
 * background. Components that spread a theme map into a `style` attribute
 * (AnimatedModal) filter through this set, so a future caller wiring
 * unvalidated data into the prop can never smuggle an arbitrary CSS property
 * (e.g. `background-image`) into the DOM — the sink enforces the contract
 * instead of relying on every caller remembering it (S-L1).
 */
const ALLOWED_THEME_VAR_KEYS: ReadonlySet<string> = new Set<string>([
  ...DERIVED_TOKENS,
  "--font-display",
  "--font-body",
  "--default-font-family",
  "--invite-section-bg",
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

/**
 * Serialise a style map into a CSS declaration string for the Astro shell,
 * which renders the palette into the SSR'd HTML so the FIRST paint is already
 * themed (no flash of the built-in dark green before a cream invite loads).
 *
 * Values reaching here are `derivePalette` output or an allow-listed font stack,
 * but the map is filtered and each value re-checked anyway: this writes into a
 * raw `style="…"` attribute.
 *
 * The character that matters is `;` — the only one that can close this
 * declaration and open another. `<`/`>` are rejected as belt-and-braces against
 * a future caller writing this somewhere Astro doesn't escape, and `\` because
 * a CSS escape sequence could otherwise reconstruct a `;`.
 *
 * Quotes are NOT rejected. An earlier version filtered them too, which silently
 * dropped every font declaration — every stack in `FONT_STACKS` contains a
 * quoted family name — so a themed invite server-rendered its colours but not
 * its typography, and only picked the fonts up on hydration. Astro escapes the
 * attribute, so a quote here cannot break out; over-broad filtering just voided
 * the feature the SSR path exists for.
 */
export function styleAttr(vars: Record<string, string>): string {
  return Object.entries(filterThemeVars(vars) ?? {})
    .filter(([, value]) => !/[;<>\\]/.test(value))
    .map(([key, value]) => `${key}:${value}`)
    .join(";");
}

/**
 * Apply the palette to the document root from a client island, so a theme change
 * picked up by the on-mount revalidation repaints the whole page — not just the
 * island that fetched it. Idempotent, and a no-op outside the browser (the Astro
 * shell owns the server-rendered copy).
 */
export function applyPaletteToRoot(theme: InviteTheme | null | undefined): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const vars = paletteRootVars(theme);

  // Remove what the PREVIOUS apply set and this one doesn't. Fonts are the case
  // that matters: an organiser clearing their heading font back to the default
  // makes `paletteRootVars` stop emitting `--font-display`, and without this the
  // value written by the SSR shell would stay on the root forever — the guest
  // would keep seeing a font the invite no longer specifies.
  for (const key of appliedKeys) {
    if (!(key in vars)) root.style.removeProperty(key);
  }
  appliedKeys = new Set(Object.keys(vars));

  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
}

/** The custom properties the last {@link applyPaletteToRoot} call set. */
let appliedKeys: ReadonlySet<string> = new Set();
