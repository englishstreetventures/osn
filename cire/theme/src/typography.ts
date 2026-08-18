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

const HEADING_SIZE_SCALES = {
  small: "0.85",
  large: "1.15",
} satisfies Record<string, string>;

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

const FONT_WEIGHT_VALUES = {
  light: "300",
  regular: "400",
  bold: "700",
} satisfies Record<string, string>;

/**
 * Style, shared by the heading and body selects. `"normal"` is kept distinct
 * from `"default"` even though today they render the same: `default` means
 * "whatever the pack does", `normal` pins it — so a future pack whose default
 * heading is italic stays overridable in both directions.
 */
export const FONT_STYLE_CHOICES = ["default", "normal", "italic"] as const;
export type FontStyleChoice = (typeof FONT_STYLE_CHOICES)[number];

const FONT_STYLE_VALUES = {
  normal: "normal",
  italic: "italic",
} satisfies Record<string, string>;

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

/** The custom property each typography setting rides on. */
export const TYPOGRAPHY_VAR_NAMES = {
  headingSize: "--invite-heading-scale",
  headingWeight: "--invite-heading-weight",
  headingStyle: "--invite-heading-style",
  bodyWeight: "--invite-body-weight",
  bodyStyle: "--invite-body-style",
} as const satisfies Record<keyof TypographySettings, string>;

/**
 * What each setting looks like when it is NOT set — i.e. the design pack's own
 * base look, which every consumer writes as the `var()` fallback:
 * `var(--invite-heading-weight, 300)`.
 *
 * These are the counterpart to the value maps above. Those say what a SET
 * option resolves to and have always lived in one place; the un-set state was
 * a literal repeated at every call site — 33 references across the two guest
 * packs plus the organiser previews — with nothing checking they agreed. A
 * pack that changed its base heading weight would have left every organiser
 * preview quietly misrepresenting "Default": the same class of bug as a
 * preview that ignores the variable outright, one level down.
 *
 * Consumers that build their declarations at runtime (the organiser's preview
 * samples) import {@link typographyVar} and hold no literal at all. The guest
 * packs CANNOT: their declarations are Tailwind arbitrary-property classes
 * (`[font-weight:var(--invite-heading-weight,300)]`), and Tailwind generates
 * CSS by scanning source text, so an interpolated class name emits no rule.
 * Those stay literal by necessity and are held to these values by
 * `typography-fallbacks.test.ts`, which scans both packages.
 */
export const TYPOGRAPHY_FALLBACKS = {
  headingSize: "1",
  headingWeight: "300",
  headingStyle: "normal",
  bodyWeight: "400",
  bodyStyle: "normal",
} as const satisfies Record<keyof TypographySettings, string>;

export type TypographyKey = keyof TypographySettings;

/**
 * The CSS reference a consumer writes for one setting, fallback included —
 * `var(--invite-heading-weight, 300)`. Use this instead of typing the literal.
 */
export function typographyVar(key: TypographyKey): string {
  return `var(${TYPOGRAPHY_VAR_NAMES[key]}, ${TYPOGRAPHY_FALLBACKS[key]})`;
}

/**
 * A heading `font-size` scaled by the organiser's heading-size option. The
 * pack (or preview) supplies its own base — a literal or its own `clamp(...)`
 * curve — and the multiplier rides on top, so the responsive curves stay where
 * they belong and only the scale is shared.
 */
export function headingSizeCss(base: string): string {
  return `calc(${base} * ${typographyVar("headingSize")})`;
}

/**
 * The custom properties {@link typographyVars} may emit. Exported so the guest
 * site's theme-variable allow-list (`ALLOWED_THEME_VAR_KEYS`) can include them
 * without hand-listing — the set and the emitter cannot drift.
 */
export const TYPOGRAPHY_VAR_KEYS = Object.values(
  TYPOGRAPHY_VAR_NAMES,
) as readonly (typeof TYPOGRAPHY_VAR_NAMES)[TypographyKey][];

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
export function typographyVars(settings: Partial<TypographySettings> | null | undefined) {
  const vars: Record<string, string> = {};
  if (!settings) return vars;
  // Property names come from TYPOGRAPHY_VAR_NAMES, so the emitter, the guest's
  // allow-list and every consumer's `var()` reference share one spelling.
  const scale = headingScale(settings.headingSize);
  if (scale) vars[TYPOGRAPHY_VAR_NAMES.headingSize] = scale;
  const headingWeight = fontWeightValue(settings.headingWeight);
  if (headingWeight) vars[TYPOGRAPHY_VAR_NAMES.headingWeight] = headingWeight;
  const headingStyle = fontStyleValue(settings.headingStyle);
  if (headingStyle) vars[TYPOGRAPHY_VAR_NAMES.headingStyle] = headingStyle;
  const bodyWeight = fontWeightValue(settings.bodyWeight);
  if (bodyWeight) vars[TYPOGRAPHY_VAR_NAMES.bodyWeight] = bodyWeight;
  const bodyStyle = fontStyleValue(settings.bodyStyle);
  if (bodyStyle) vars[TYPOGRAPHY_VAR_NAMES.bodyStyle] = bodyStyle;
  return vars;
}
