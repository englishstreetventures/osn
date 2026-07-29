/**
 * The invite typography options: heading size / weight / style plus body
 * weight / style. Global — one setting per invite, alongside the two font
 * faces — and CLOSED, for the same reason `FONT_CHOICES` is: only the KEY is
 * ever persisted or sent over the wire, and every key resolves here to a fixed
 * CSS value, so free text can never reach a rendered `style`.
 *
 * Like the font stacks, this map is the single copy every side of the boundary
 * imports: the API's `Schema.Literal(...)` enums, the guest site's root
 * variables, and the organiser's live preview. `"default"` (or an unknown /
 * absent key) resolves to `null` — emit nothing and let the design pack's
 * built-in literal win — so an un-configured invite renders exactly as it
 * always has.
 */

// ── Choices ───────────────────────────────────────────────────────────────────

/**
 * Heading size, as a multiplier on each pack's existing `clamp(...)` — the
 * packs keep their own responsive curves, the organiser just nudges the whole
 * family. Three steps: fewer decisions than a free size, and a step is big
 * enough to see but too small to break a layout.
 */
export const HEADING_SIZE_CHOICES = ["default", "small", "large"] as const;
export type HeadingSizeChoice = (typeof HEADING_SIZE_CHOICES)[number];

const HEADING_SIZE_SCALES: Record<string, string> = {
  small: "0.85",
  large: "1.15",
};

/**
 * Weight, shared by the heading and body selects. The numeric values are
 * faces the loaded fonts actually SHIP — Cormorant Garamond and Lato both
 * carry true 300 / 400 / 700 (upright and italic; the guest + organiser font
 * links load them) — so a pick maps to a real face, never faux-bold
 * synthesis. Lato has no 500/600, which is why there is no `medium` /
 * `semibold` step.
 */
export const FONT_WEIGHT_CHOICES = ["default", "light", "regular", "bold"] as const;
export type FontWeightChoice = (typeof FONT_WEIGHT_CHOICES)[number];

const FONT_WEIGHT_VALUES: Record<string, string> = {
  light: "300",
  regular: "400",
  bold: "700",
};

/**
 * Style, shared by the heading and body selects. `"normal"` is kept distinct
 * from `"default"` even though today they render the same: `default` means
 * "whatever the pack does", `normal` pins it — so a future pack whose default
 * heading is italic stays overridable in both directions.
 */
export const FONT_STYLE_CHOICES = ["default", "normal", "italic"] as const;
export type FontStyleChoice = (typeof FONT_STYLE_CHOICES)[number];

const FONT_STYLE_VALUES: Record<string, string> = {
  normal: "normal",
  italic: "italic",
};

// ── Resolution ────────────────────────────────────────────────────────────────

// `Object.hasOwn` (not a bare index) so prototype-chain keys ("constructor",
// "toString", …) resolve to null like any other unknown key — this resolver is
// the render-time half of the injection defence, so it must stay closed for
// EVERY string, not just ones that miss the prototype (S-L1).
function ownValue(map: Record<string, string>, choice: string): string | null {
  return Object.hasOwn(map, choice) ? map[choice] : null;
}

/** Resolve a heading-size key to its scale factor, or `null` to keep the default. */
export function headingScale(choice: string | null | undefined): string | null {
  if (!choice || choice === "default") return null;
  return ownValue(HEADING_SIZE_SCALES, choice);
}

/** Resolve a weight key to its numeric CSS value, or `null` to keep the default. */
export function fontWeightValue(choice: string | null | undefined): string | null {
  if (!choice || choice === "default") return null;
  return ownValue(FONT_WEIGHT_VALUES, choice);
}

/** Resolve a style key to its CSS `font-style`, or `null` to keep the default. */
export function fontStyleValue(choice: string | null | undefined): string | null {
  if (!choice || choice === "default") return null;
  return ownValue(FONT_STYLE_VALUES, choice);
}

// ── Root variables ────────────────────────────────────────────────────────────

/**
 * The five typography settings as they ride on the invite theme. Every field
 * nullable — `null` means "use the pack's built-in look", same contract as the
 * palette seeds and font faces.
 */
export interface TypographySettings {
  headingSize: string | null;
  headingWeight: string | null;
  headingStyle: string | null;
  bodyWeight: string | null;
  bodyStyle: string | null;
}

/**
 * The custom properties {@link typographyVars} may emit. Exported so the guest
 * site's theme-variable allow-list (`ALLOWED_THEME_VAR_KEYS`) can include them
 * without hand-listing — the set and the emitter cannot drift.
 */
export const TYPOGRAPHY_VAR_KEYS = [
  "--invite-heading-scale",
  "--invite-heading-weight",
  "--invite-heading-style",
  "--invite-body-weight",
  "--invite-body-style",
] as const;

/**
 * The root style map for an invite's typography. Emits a variable only for a
 * set-and-known key — an absent/unknown key emits nothing, so the design
 * pack's literal fallback wins (`var(--invite-heading-weight, 300)` etc.).
 * Values come from the closed maps above, never from the payload, so nothing
 * new crosses the CSS-injection gate.
 *
 * The heading variables are consumed by the packs' heading elements; the body
 * pair is applied to the page content wrapper and cascades by inheritance,
 * with headings' explicit declarations overriding it.
 */
export function typographyVars(
  settings: Partial<TypographySettings> | null | undefined,
): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!settings) return vars;
  const scale = headingScale(settings.headingSize);
  if (scale) vars["--invite-heading-scale"] = scale;
  const headingWeight = fontWeightValue(settings.headingWeight);
  if (headingWeight) vars["--invite-heading-weight"] = headingWeight;
  const headingStyle = fontStyleValue(settings.headingStyle);
  if (headingStyle) vars["--invite-heading-style"] = headingStyle;
  const bodyWeight = fontWeightValue(settings.bodyWeight);
  if (bodyWeight) vars["--invite-body-weight"] = bodyWeight;
  const bodyStyle = fontStyleValue(settings.bodyStyle);
  if (bodyStyle) vars["--invite-body-style"] = bodyStyle;
  return vars;
}
