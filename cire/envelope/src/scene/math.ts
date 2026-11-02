/**
 * The scene's arithmetic, with no `three` and no DOM, so it is tested alone.
 */

/** The fastest the opening plays: three taps in. */
export const MAX_RATE = 8;

/**
 * The playback rate after one more tap. The first tap starts the opening at 1;
 * each tap after it steps the rate 1, 3, 8, then holds, so two quick taps
 * finish a 2.4 s opening in about 0.8 s.
 */
export function nextRate(rate: number): number {
  if (rate < 3) return 3;
  return MAX_RATE;
}

/**
 * The camera distance at which a plane `height` units tall at z = 0 fills a
 * perspective camera's vertical field of view exactly. With the world measured
 * in CSS pixels and the camera's aspect set to the viewport's, a
 * viewport-sized plane there covers the viewport pixel for pixel: the frame
 * the opening ends on.
 */
export function fitDistance(height: number, fovDegrees: number): number {
  return height / 2 / Math.tan((fovDegrees * Math.PI) / 360);
}
