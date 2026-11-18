/**
 * `--motion-scale` on the root, which every time in `global.css` is multiplied
 * by; 1 when it is unset or unreadable. A time script waits out multiplies by
 * it too, so it stays in step with the stylesheet when the scale slows motion
 * down to be judged frame by frame (`cire/invites/DESIGN.md` §5).
 */
export function motionScale(): number {
  const scale = Number.parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--motion-scale"),
  );
  return Number.isFinite(scale) ? scale : 1;
}
