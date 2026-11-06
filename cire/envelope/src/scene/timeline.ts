/**
 * The opening's phases and their lengths in animation seconds, at playback
 * rate 1. The scene advances animation time by real time times the rate, so a
 * tap that raises the rate shortens whatever is left.
 *
 * `sealed` waits for the first tap. `breaking` runs the seal's break and lasts
 * at least {@link BREAK_S}, longer only if the seal has not let go of the flap.
 * `flap` opens the flap, `slide` lifts the card out, `fill` brings it forward
 * until it is the viewport at 1:1, and `done` is that frame.
 */
export type Phase = "sealed" | "breaking" | "flap" | "slide" | "fill" | "done";

export const BREAK_S = 0.45;
export const FLAP_S = 0.55;
export const SLIDE_S = 0.6;
export const FILL_S = 0.8;

/** Idle time after the envelope is armed before the prompt words show. */
export const PROMPT_DELAY_MS = 3000;

/** The longest `done` waits for the live hero's last upload before landing on what it has. */
export const LAND_WAIT_MS = 300;

/**
 * How long, from the first tap, the opening may take before it is abandoned
 * and the page shown as it is. Well past the 2.4 s it takes at rate 1.
 */
export const OPENING_DEADLINE_MS = 6000;

/** The longest one frame may advance the opening, so a stall resumes rather than skips. */
export const MAX_FRAME_S = 0.1;

export function clamp01(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function easeInOutCubic(t: number): number {
  const x = clamp01(t);
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}

export function easeInCubic(t: number): number {
  const x = clamp01(t);
  return x * x * x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
