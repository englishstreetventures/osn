/**
 * Test hooks on `window.__cireWaves`, for development builds only. The E2E
 * flow runs against `astro dev` and uses them to hold the Gilded wave at one
 * point of its run and to read the Distortion controller's state; neither
 * wave has another way to be pictured at a fixed point.
 *
 * Every line that names the global sits inside `import.meta.env.DEV`, which a
 * production build replaces with `false` and drops, so no production bundle
 * carries the hook (`tests/hooks.test.ts`).
 */

import type { WaveController } from "../vendor/controller";

export interface WaveHooks {
  /** Holds the Gilded wave, the one running or the next, at `p` (0–1) of its run. */
  holdGilded?: (p: number) => Promise<void>;
  /** Lets a held Gilded wave go: it ends where it was going, at once. */
  releaseGilded?: () => void;
  /** The mounted Distortion controller's `debug`, or `null`. */
  distortion?: () => WaveController["debug"] | null;
}

/** Adds `hooks` to `window.__cireWaves` in a development build; does nothing otherwise. */
export function exposeHooks(hooks: WaveHooks): void {
  if (import.meta.env.DEV && typeof window !== "undefined") {
    const target = window as Window & { __cireWaves?: WaveHooks };
    target.__cireWaves = { ...target.__cireWaves, ...hooks };
  }
}
