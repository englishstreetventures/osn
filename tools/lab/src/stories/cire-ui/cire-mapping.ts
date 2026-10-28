/**
 * cire's mapping of the `--ui-*` contract, as inline custom properties.
 *
 * A wrapper element that takes `cireStyle(theme)` as its `style` gives every
 * `ui-*` utility inside it cire's values, which is how a `@cire/ui` story and
 * the design-system theming story show cire without importing an app
 * stylesheet (`wiki/conventions/component-lab.md` §Stories for auth and cire
 * components). Not a story file, so the registry does not read its exports.
 */

import type { JSX } from "solid-js";

import type {
  ColorToken,
  LeadingStep,
  RadiusToken,
  TextStep,
  TrackingStep,
} from "../design-system/utilities.ts";

export type CireTheme = "dark" | "light";

/**
 * cire's colour ramps, resolved by hand.
 *
 * Copied from `cire/host/src/styles/global.css` — the `:root` ramp for dark and
 * the `:root[data-theme="light"]` ramp for light, followed through the
 * `--ui-*: var(--…)` block at the bottom of that file. Every colour is the
 * literal that block resolves to; nothing here is invented. The fonts are
 * left out: cire's faces are self-hosted by its Astro pipeline and are not
 * loaded in the lab, so a mapping to them would render the platform fallback
 * while claiming to be cire.
 */
const CIRE_COLOR = {
  dark: {
    "--ui-ground": "oklch(16.8% 0.026 148)",
    "--ui-ground-deep": "oklch(13.2% 0.021 148)",
    "--ui-surface": "oklch(20.6% 0.028 149)",
    "--ui-surface-raised": "oklch(24.4% 0.032 149)",
    "--ui-surface-sunk": "oklch(14.4% 0.022 148)",
    "--ui-hairline": "oklch(85% 0.06 145 / 0.11)",
    "--ui-hairline-strong": "oklch(85% 0.06 145 / 0.44)",
    "--ui-ink": "oklch(94.6% 0.011 90)",
    "--ui-ink-secondary": "oklch(94.6% 0.011 90 / 0.58)",
    "--ui-ink-tertiary": "oklch(94.6% 0.011 90 / 0.4)",
    "--ui-accent": "oklch(75% 0.085 82)",
    "--ui-accent-strong": "oklch(82% 0.085 82)",
    "--ui-accent-soft": "oklch(75% 0.085 82 / 0.3)",
    "--ui-accent-ink": "oklch(84% 0.072 84)",
    "--ui-on-accent": "oklch(16.8% 0.026 148)",
    "--ui-success": "oklch(76% 0.142 147)",
    "--ui-warn": "oklch(80% 0.125 78)",
    "--ui-danger": "oklch(68% 0.14 21)",
    "--ui-on-danger": "oklch(16.8% 0.026 148)",
    "--ui-focus": "oklch(75% 0.085 82)",
  },
  light: {
    "--ui-ground": "oklch(88.6% 0.011 92)",
    "--ui-ground-deep": "oklch(84.5% 0.014 92)",
    "--ui-surface": "oklch(92.4% 0.009 92)",
    "--ui-surface-raised": "oklch(95.2% 0.007 92)",
    "--ui-surface-sunk": "oklch(85.8% 0.013 92)",
    "--ui-hairline": "oklch(44% 0.022 340 / 0.18)",
    "--ui-hairline-strong": "oklch(44% 0.022 340 / 0.74)",
    "--ui-ink": "oklch(27% 0.018 340)",
    "--ui-ink-secondary": "oklch(44% 0.022 340)",
    "--ui-ink-tertiary": "oklch(44% 0.022 340 / 0.74)",
    "--ui-accent": "oklch(64% 0.095 78)",
    "--ui-accent-strong": "oklch(70% 0.095 78)",
    "--ui-accent-soft": "oklch(64% 0.095 78 / 0.34)",
    "--ui-accent-ink": "oklch(46% 0.082 74)",
    "--ui-on-accent": "oklch(24% 0.018 340)",
    "--ui-success": "oklch(43% 0.115 148)",
    "--ui-warn": "oklch(45% 0.105 62)",
    "--ui-danger": "oklch(50% 0.15 25)",
    "--ui-on-danger": "oklch(88.6% 0.011 92)",
    "--ui-focus": "oklch(38% 0.072 141)",
  },
} as const satisfies Record<CireTheme, Record<ColorToken, string>>;

/**
 * cire's radius roles, the same in both themes (englishstreetventures/osn#1821):
 * pill buttons, 14px text fields, 16px cards, and the 2, 6 and 10px steps for
 * the small marks — a checkbox or a tooltip stays small-cornered.
 */
const CIRE_RADIUS = {
  "--ui-radius-hair": "2px",
  "--ui-radius-sm": "6px",
  "--ui-radius-md": "10px",
  "--ui-radius-lg": "16px",
  "--ui-radius-pill": "999px",
  "--ui-radius-control": "999px",
  /* Apart from `control`: a pill text field reads as a search box. */
  "--ui-radius-field": "14px",
  /* A sheet's grip is measured against the screen edge it is pulled from, not
     against a card's corner. */
  "--ui-radius-sheet": "28px",
} as const satisfies Record<RadiusToken, string>;

const CIRE_TEXT = {
  "--ui-text-xs": "0.72rem",
  "--ui-text-sm": "0.82rem",
  "--ui-text-base": "0.9rem",
  "--ui-text-md": "1.05rem",
  "--ui-text-lg": "1.3rem",
  "--ui-text-xl": "1.75rem",
  "--ui-text-2xl": "2.5rem",
} as const satisfies Record<`--ui-text-${TextStep}`, string>;

const CIRE_TRACKING = {
  "--ui-tracking-tight": "-0.02em",
  "--ui-tracking-normal": "0em",
  "--ui-tracking-wide": "0.04em",
  "--ui-tracking-wider": "0.1em",
  "--ui-tracking-widest": "0.16em",
  "--ui-tracking-ultra": "0.2em",
} as const satisfies Record<`--ui-tracking-${TrackingStep}`, string>;

const CIRE_LEADING = {
  "--ui-leading-none": "1.1",
  "--ui-leading-tight": "1.2",
  "--ui-leading-snug": "1.4",
  "--ui-leading-normal": "1.6",
  "--ui-leading-relaxed": "1.75",
} as const satisfies Record<`--ui-leading-${LeadingStep}`, string>;

/** Every `--ui-*` token cire maps, for one theme, ready for a `style` prop. */
export function cireStyle(which: CireTheme): JSX.CSSProperties {
  return { ...CIRE_COLOR[which], ...CIRE_RADIUS, ...CIRE_TEXT, ...CIRE_TRACKING, ...CIRE_LEADING };
}
