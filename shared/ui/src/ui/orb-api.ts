/**
 * The types `@shared/ui/ui/orb` gives a consumer, and nothing else.
 *
 * `package.json` points the export's `types` condition here and its `default`
 * condition at `orb.tsx`. A consumer's TypeScript reads this file and stops;
 * only the bundler follows `orb.tsx` into the vendored engine
 * (`shared/ui/vendor/thinking-orbs`). The engine is upstream source, kept
 * byte for byte, and it declares a parameter it never reads, so any consumer
 * that sets `noUnusedParameters` (`tools/lab`, `musubi/social`, `pulse/web`,
 * `tools/metrics`) would fail its own type check if its compiler followed the
 * import there.
 *
 * A `.ts` file rather than a `.d.ts`: `@shared/typescript-config/base.json`
 * sets `skipLibCheck`, which would leave a declaration file unchecked, so a
 * mistake in it would reach callers as `any`. As a `.ts` file, each consumer checks it under its own
 * flags.
 *
 * `orb.tsx` declares its `Orb` as `typeof Orb` from here, so the package's own
 * type check fails if the two ever disagree.
 */
import type { Component } from "solid-js";

/**
 * The nine animations upstream ships, each tuned by hand:
 * `working` (particles on tilted orbits), `searching` (a meridian sweeps a
 * dotted globe), `solving` (bands turn and click back), `listening` (a wave
 * rolls through rings), `connecting` (a constellation wires itself),
 * `weaving` (three strands plait), `composing` (a multi-band sash),
 * `breathing` (a face-on ring) and `shaping` (an outline morphs between a
 * circle, a triangle and a square).
 */
export type OrbState =
  | "working"
  | "searching"
  | "solving"
  | "listening"
  | "connecting"
  | "weaving"
  | "composing"
  | "breathing"
  | "shaping";

export interface OrbProps {
  /** Which animation to draw. Defaults to `"working"`. */
  state?: OrbState;
  /**
   * The design to draw, in CSS pixels at the default root font size: 20 sits
   * inline with text, 64 stands alone. They are two designs tuned by hand,
   * each with its own dot count, dot size and speed, not one design scaled.
   */
  size: 20 | 64;
  class?: string;
}

/**
 * A dotted sphere that moves while something is in progress.
 *
 * Decoration only: the canvas is `aria-hidden` and has no name, so put it
 * inside a control whose own label says what is happening. Its ink is the
 * text colour it inherits, so it reads on whatever ground that text is set
 * for: the near dots take the colour, and the far ones fade toward white, or
 * toward black when the colour is a light one. It moves for at most five
 * seconds, then holds a still frame; it holds that frame from the start under
 * `prefers-reduced-motion: reduce`, and stops drawing while it is off screen
 * or the tab is hidden.
 */
export declare const Orb: Component<OrbProps>;
