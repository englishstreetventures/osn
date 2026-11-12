/**
 * One frame of a Kobalte overlay's open or close, held and read in the page.
 *
 * `@shared/ui`'s overlays open on the `ui-enter` keyframes and close on
 * `ui-exit` (`shared/design-tokens/src/tokens.css`), each a 120ms or 80ms run,
 * too short to catch by reading after an action. `holdOverlay` listens for the
 * run's `animationstart` in the page, pauses it at a fraction of the way
 * through, reads the panel's `transform` and `opacity`, and lets it finish, as
 * `shared/ui/tests/overlay-motion.browser.test.tsx` does. It waits on the read
 * itself, never on a clock (`tests/flows.test.ts` forbids timeouts).
 *
 * The listener goes in before the action that opens or closes the overlay,
 * and catches the first matching run after it.
 */

import type { Page } from "@playwright/test";

/** The keyframes a Kobalte overlay opens or closes on. */
export type OverlayRun = "ui-enter" | "ui-exit";

/** What the panel computed on the held frame. */
export interface HeldFrame {
  /** The computed `transform`, as the browser wrote it. */
  transform: string;
  /** No scale and no shift: the transform is the identity matrix. */
  identity: boolean;
  /** The matrix's horizontal scale, to three places. */
  scale: number;
  opacity: number;
}

interface HeldWindow {
  __heldFrames?: Record<string, Omit<HeldFrame, "identity" | "scale"> | undefined>;
}

/**
 * Holds the first `run` that starts on an element matching `selector`, at
 * `at` (0 to 1) of the way through. Returns a read that waits until the frame
 * has been caught, then gives it back.
 */
export async function holdOverlay(
  page: Page,
  selector: string,
  run: OverlayRun,
  at: number,
): Promise<() => Promise<HeldFrame>> {
  const key = `${selector}|${run}`;
  await page.evaluate(
    ([sel, name, fraction, slot]) => {
      const held = ((window as HeldWindow).__heldFrames ??= {});
      held[slot] = undefined;
      const listen = (event: AnimationEvent) => {
        if (event.animationName !== name) return;
        const panel = event.target;
        if (!(panel instanceof HTMLElement) || !panel.matches(sel)) return;
        const animation = panel
          .getAnimations()
          .find((a) => a instanceof CSSAnimation && a.animationName === name);
        if (!animation) return;
        document.removeEventListener("animationstart", listen, true);
        animation.pause();
        animation.currentTime =
          Number(animation.effect?.getComputedTiming().duration ?? 0) * fraction;
        const style = getComputedStyle(panel);
        held[slot] = { transform: style.transform, opacity: Number(style.opacity) };
        animation.finish();
      };
      document.addEventListener("animationstart", listen, true);
    },
    [selector, run, at, key] as const,
  );
  return async () => {
    await page.waitForFunction(
      (slot) => (window as HeldWindow).__heldFrames?.[slot] !== undefined,
      key,
    );
    return page.evaluate((slot) => {
      const frame = (window as HeldWindow).__heldFrames![slot]!;
      const matrix = new DOMMatrix(frame.transform === "none" ? undefined : frame.transform);
      return {
        ...frame,
        identity: matrix.isIdentity,
        scale: Math.round(matrix.a * 1000) / 1000,
      };
    }, key);
  };
}
