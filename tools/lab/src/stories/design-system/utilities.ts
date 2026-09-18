/**
 * The contract's tokens, each paired with the utility that spells it.
 *
 * Tailwind emits only the class names it can see written out in a source
 * file, so a gallery that iterates `CONTRACT_COLOR_TOKENS` and builds
 * `` `bg-ui-${name}` `` at runtime renders nothing — the utility is never
 * generated, the box is transparent, and no gate notices. These tables are the
 * literal spellings Tailwind needs, and each is `satisfies Record<Token, …>`
 * against the contract's own export, so adding a token to
 * `@shared/design-tokens` without adding it here is a type error rather than
 * a swatch that quietly went missing.
 *
 * Nothing here is a second list of tokens. The keys are the contract's; only
 * the values are ours.
 */

import {
  CONTRACT_COLOR_TOKENS,
  CONTRACT_SCALAR_TOKENS,
  CONTRACT_SCALES,
} from "@shared/design-tokens";

/** Every colour token, as the literal union `CONTRACT_COLOR_TOKENS` carries. */
export type ColorToken = (typeof CONTRACT_COLOR_TOKENS)[keyof typeof CONTRACT_COLOR_TOKENS][number];

export type TextStep = keyof typeof CONTRACT_SCALES.text;
export type TrackingStep = keyof typeof CONTRACT_SCALES.tracking;
export type LeadingStep = keyof typeof CONTRACT_SCALES.leading;
export type MeasureStep = keyof typeof CONTRACT_SCALES.measure;
export type RadiusToken = (typeof CONTRACT_SCALAR_TOKENS.radius)[number];
export type FontToken = (typeof CONTRACT_SCALAR_TOKENS.fontFamily)[number];

/** `bg-ui-*` — the token as a fill. */
export const BG = {
  "--ui-ground": "bg-ui-ground",
  "--ui-ground-deep": "bg-ui-ground-deep",
  "--ui-surface": "bg-ui-surface",
  "--ui-surface-raised": "bg-ui-surface-raised",
  "--ui-surface-sunk": "bg-ui-surface-sunk",
  "--ui-hairline": "bg-ui-hairline",
  "--ui-hairline-strong": "bg-ui-hairline-strong",
  "--ui-ink": "bg-ui-ink",
  "--ui-ink-secondary": "bg-ui-ink-secondary",
  "--ui-ink-tertiary": "bg-ui-ink-tertiary",
  "--ui-accent": "bg-ui-accent",
  "--ui-accent-strong": "bg-ui-accent-strong",
  "--ui-accent-soft": "bg-ui-accent-soft",
  "--ui-accent-ink": "bg-ui-accent-ink",
  "--ui-on-accent": "bg-ui-on-accent",
  "--ui-success": "bg-ui-success",
  "--ui-warn": "bg-ui-warn",
  "--ui-danger": "bg-ui-danger",
  "--ui-on-danger": "bg-ui-on-danger",
  "--ui-focus": "bg-ui-focus",
} as const satisfies Record<ColorToken, string>;

/** `text-ui-*` — the token as ink. */
export const TEXT = {
  "--ui-ground": "text-ui-ground",
  "--ui-ground-deep": "text-ui-ground-deep",
  "--ui-surface": "text-ui-surface",
  "--ui-surface-raised": "text-ui-surface-raised",
  "--ui-surface-sunk": "text-ui-surface-sunk",
  "--ui-hairline": "text-ui-hairline",
  "--ui-hairline-strong": "text-ui-hairline-strong",
  "--ui-ink": "text-ui-ink",
  "--ui-ink-secondary": "text-ui-ink-secondary",
  "--ui-ink-tertiary": "text-ui-ink-tertiary",
  "--ui-accent": "text-ui-accent",
  "--ui-accent-strong": "text-ui-accent-strong",
  "--ui-accent-soft": "text-ui-accent-soft",
  "--ui-accent-ink": "text-ui-accent-ink",
  "--ui-on-accent": "text-ui-on-accent",
  "--ui-success": "text-ui-success",
  "--ui-warn": "text-ui-warn",
  "--ui-danger": "text-ui-danger",
  "--ui-on-danger": "text-ui-on-danger",
  "--ui-focus": "text-ui-focus",
} as const satisfies Record<ColorToken, string>;

/** `border-ui-*` — the token as an edge. */
export const BORDER = {
  "--ui-ground": "border-ui-ground",
  "--ui-ground-deep": "border-ui-ground-deep",
  "--ui-surface": "border-ui-surface",
  "--ui-surface-raised": "border-ui-surface-raised",
  "--ui-surface-sunk": "border-ui-surface-sunk",
  "--ui-hairline": "border-ui-hairline",
  "--ui-hairline-strong": "border-ui-hairline-strong",
  "--ui-ink": "border-ui-ink",
  "--ui-ink-secondary": "border-ui-ink-secondary",
  "--ui-ink-tertiary": "border-ui-ink-tertiary",
  "--ui-accent": "border-ui-accent",
  "--ui-accent-strong": "border-ui-accent-strong",
  "--ui-accent-soft": "border-ui-accent-soft",
  "--ui-accent-ink": "border-ui-accent-ink",
  "--ui-on-accent": "border-ui-on-accent",
  "--ui-success": "border-ui-success",
  "--ui-warn": "border-ui-warn",
  "--ui-danger": "border-ui-danger",
  "--ui-on-danger": "border-ui-on-danger",
  "--ui-focus": "border-ui-focus",
} as const satisfies Record<ColorToken, string>;

export const TEXT_SIZE = {
  xs: "text-ui-xs",
  sm: "text-ui-sm",
  base: "text-ui-base",
  md: "text-ui-md",
  lg: "text-ui-lg",
  xl: "text-ui-xl",
  "2xl": "text-ui-2xl",
} as const satisfies Record<TextStep, string>;

export const TRACKING = {
  tight: "tracking-ui-tight",
  normal: "tracking-ui-normal",
  wide: "tracking-ui-wide",
  wider: "tracking-ui-wider",
  widest: "tracking-ui-widest",
  ultra: "tracking-ui-ultra",
} as const satisfies Record<TrackingStep, string>;

export const LEADING = {
  none: "leading-ui-none",
  tight: "leading-ui-tight",
  snug: "leading-ui-snug",
  normal: "leading-ui-normal",
  relaxed: "leading-ui-relaxed",
} as const satisfies Record<LeadingStep, string>;

/** `max-w-ui-*`: Tailwind reads a `max-w-*` from the `--container-*` namespace. */
export const MEASURE = {
  xs: "max-w-ui-xs",
  sm: "max-w-ui-sm",
  md: "max-w-ui-md",
  lg: "max-w-ui-lg",
  xl: "max-w-ui-xl",
  "2xl": "max-w-ui-2xl",
  "3xl": "max-w-ui-3xl",
} as const satisfies Record<MeasureStep, string>;

/** `rounded-ui-*`: Tailwind reads a `rounded-*` from the `--radius-*` namespace. */
export const ROUNDED = {
  "--ui-radius-hair": "rounded-ui-hair",
  "--ui-radius-sm": "rounded-ui-sm",
  "--ui-radius-md": "rounded-ui-md",
  "--ui-radius-lg": "rounded-ui-lg",
  "--ui-radius-pill": "rounded-ui-pill",
  "--ui-radius-control": "rounded-ui-control",
  "--ui-radius-sheet": "rounded-ui-sheet",
} as const satisfies Record<RadiusToken, string>;

export const FONT = {
  "--ui-font-body": "font-ui-body",
  "--ui-font-display": "font-ui-display",
  "--ui-font-mono": "font-ui-mono",
} as const satisfies Record<FontToken, string>;

/** `--ui-ground` → `ground`. For labels; the token name itself is shown in full beside it. */
export function shortName(token: string): string {
  return token.replace(/^--ui-/, "");
}
