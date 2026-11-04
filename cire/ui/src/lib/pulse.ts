/**
 * The one pulse a loading placeholder runs: `Loading`'s line and every
 * `Skeleton` block, so two loaders on one screen pulse in step.
 *
 * Tailwind's `pulse` keyframes (down to half opacity and back) over 2s, scaled
 * by the app's `--motion-scale` and eased on its `--ease-in-out`, the timing
 * the host's attention glow uses. Each cire app declares both; where an app
 * declares no curve, the contract's `--ui-ease-in-out` (the same house curve)
 * stands in, and with no scale the pulse runs at 1×. Tailwind's own
 * `animate-pulse` is a fixed 2s on its own curve, which no motion token moves.
 *
 * Each app's reduced-motion rule clamps every animation to one 0.01ms run, so
 * the pulse stops at full opacity without this module knowing.
 *
 * Internal: not an export of the package. The class is written out in full so
 * Tailwind's source scan finds it; a class built at run time emits no CSS.
 */
export const PULSE =
  "base:animate-[pulse_calc(2s*var(--motion-scale,1))_var(--ease-in-out,var(--ui-ease-in-out))_infinite]";
