/**
 * One frame of a Kobalte overlay's open or close, held and read in the page.
 *
 * `@shared/ui`'s overlays open on the `ui-enter` keyframes and close on
 * `ui-exit` (`shared/design-tokens/src/tokens.css`), each a 120ms or 80ms run,
 * too short to catch by reading after an action. A `Dialog` sheet below `md`
 * slides by `transform` and `opacity` transitions instead, over 320ms in and
 * 200ms out, and runs `ui-sheet-enter` and `ui-sheet-exit`, keyframes that
 * move nothing, beside them. `holdOverlay` listens for the named run's
 * `animationstart` in the page, pauses every animation and transition on the
 * panel and on the scrim before it at the same fraction of each one's run,
 * reads the panel, and lets them all finish, as
 * `shared/ui/tests/overlay-motion.browser.test.tsx` does. It waits on the read
 * itself, never on a clock (`tests/flows.test.ts` forbids timeouts).
 *
 * The listener goes in before the action that opens or closes the overlay,
 * and catches the first matching run after it.
 */

import type { Page } from "@playwright/test";

/** The keyframes a Kobalte overlay opens or closes on: the card's two, or a sheet's two. */
export type OverlayRun = "ui-enter" | "ui-exit" | "ui-sheet-enter" | "ui-sheet-exit";

/** What the panel computed on the held frame. */
export interface HeldFrame {
  /** The computed `transform`, as the browser wrote it. */
  transform: string;
  /** No scale and no shift: the transform is the identity matrix. */
  identity: boolean;
  /** The matrix's horizontal scale, to three places. */
  scale: number;
  opacity: number;
  /** How far the panel sits below the window's bottom edge, to the whole px. */
  shiftY: number;
  /** The panel's height, to the whole px. */
  height: number;
}

type Read = Pick<HeldFrame, "transform" | "opacity" | "shiftY" | "height">;

interface HeldWindow {
  __heldFrames?: Record<string, Read | undefined>;
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
        document.removeEventListener("animationstart", listen, true);
        // A dialog's scrim is the fixed element Kobalte draws just before it;
        // a menu or popover has none.
        const before = panel.previousElementSibling;
        const scrim =
          before instanceof HTMLElement && getComputedStyle(before).position === "fixed"
            ? [before]
            : [];
        const runs = [panel, ...scrim].flatMap((el) => el.getAnimations());
        for (const each of runs) {
          each.pause();
          each.currentTime = Number(each.effect?.getComputedTiming().duration ?? 0) * fraction;
        }
        const style = getComputedStyle(panel);
        const box = panel.getBoundingClientRect();
        held[slot] = {
          transform: style.transform,
          opacity: Number(style.opacity),
          shiftY: Math.round(box.bottom - window.innerHeight),
          height: Math.round(box.height),
        };
        for (const each of runs) each.finish();
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
