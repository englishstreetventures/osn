/**
 * The one pulse a loading placeholder runs: `Loading`'s line and every
 * `Skeleton` block, so two loaders on one screen pulse in step.
 *
 * Tailwind's `pulse` keyframes (down to half opacity and back) over 2s, scaled
 * by the app's `--motion-scale` and eased on its `--ease-in-out`, the timing
 * the host's attention glow uses. All four cire apps declare both; with no
 * scale the pulse runs at 1×. The curve is always the page's `--ease-in-out`:
 * Tailwind's theme declares one of its own (a different curve) wherever the app
 * does not, so the contract's `--ui-ease-in-out` behind it is reached only on a
 * page with no Tailwind theme. An app that wants the house curve declares it,
 * as the component lab's story does. Tailwind's own `animate-pulse` is a fixed
 * 2s on its own curve, which no motion token moves.
 *
 * Each app's reduced-motion rule clamps every animation to one 0.01ms run, so
 * the pulse stops at full opacity without this module knowing.
 *
 * Internal: not an export of the package. The class is written out in full so
 * Tailwind's source scan finds it; a class built at run time emits no CSS. For
 * the same reason `SkeletonOutline` writes these values out again, on the
 * selectors for its bars, blocks and glyphs; its browser test fails when the
 * two compute differently.
 */
export const PULSE =
  "base:animate-[pulse_calc(2s*var(--motion-scale,1))_var(--ease-in-out,var(--ui-ease-in-out))_infinite]";
