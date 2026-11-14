/**
 * pulse's share sheet, the one `Dialog` sheet pulse draws, moving under
 * pulse's own stylesheet at a phone width: it rises from its own height below
 * the bottom edge at full opacity with nothing scaled, its scrim starting
 * clear, and settles on the bottom edge; under reduced motion it starts clear
 * in place instead, and fades in with its scrim. `@shared/ui`'s
 * `overlay-motion.browser.test.tsx` holds the rest of the slide and the fade
 * against its test palette; this holds that pulse's stylesheet, which maps
 * none of the motion tokens and has no reduced-motion rule of its own, leaves
 * both intact. Not in `token-contract.browser.test.tsx`,
 * which turns every transition off for its colour reads.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { commands, page, userEvent } from "vitest/browser";

import { ShareEventButton } from "../../src/components/ShareEventButton";

import "../../src/app.css";

afterEach(async () => {
  await commands.emulateMedia({ reducedMotion: "no-preference" });
  cleanup();
});

interface Frame {
  /** How far below its resting place the panel sits: its bottom edge less the window's. */
  shift: number;
  height: number;
  transform: string;
  opacity: number;
  scrim: number;
}

/** The scrim, which Kobalte draws just before the panel. */
function scrimOf(panel: Element): HTMLElement {
  const scrim = panel.previousElementSibling;
  if (!(scrim instanceof HTMLElement)) throw new Error("no scrim before the sheet");
  return scrim;
}

function read(panel: HTMLElement): Frame {
  const box = panel.getBoundingClientRect();
  const style = getComputedStyle(panel);
  return {
    shift: box.bottom - innerHeight,
    height: box.height,
    transform: style.transform,
    opacity: Number(style.opacity),
    scrim: Number(getComputedStyle(scrimOf(panel)).opacity),
  };
}

/**
 * Open the share sheet at 390px and hold its first frame: every run on the
 * panel and its scrim paused at 0 the moment the sheet's run starts on the
 * panel, before a frame of it is drawn.
 */
async function openHeld(): Promise<{ frame: Frame; runs: Animation[]; panel: HTMLElement }> {
  await page.viewport(390, 844);
  render(() => <ShareEventButton eventId="evt_1" eventTitle="Picnic" />);

  let held: { frame: Frame; runs: Animation[]; panel: HTMLElement } | undefined;
  const listen = (event: AnimationEvent) => {
    const panel = event.target;
    if (held || event.animationName !== "ui-sheet-enter") return;
    if (!(panel instanceof HTMLElement) || panel.getAttribute("role") !== "dialog") return;
    const runs = [...panel.getAnimations(), ...scrimOf(panel).getAnimations()];
    for (const run of runs) {
      run.pause();
      run.currentTime = 0;
    }
    held = { frame: read(panel), runs, panel };
  };
  document.addEventListener("animationstart", listen, true);
  await userEvent.click(screen.getByRole("button", { name: "Share event" }));
  const caught = await vi.waitFor(
    () => {
      if (!held) throw new Error("the share sheet ran no ui-sheet-enter");
      return held;
    },
    { timeout: 3000 },
  );
  document.removeEventListener("animationstart", listen, true);
  return caught;
}

it("rises from below the bottom edge at 390px, at full opacity, and settles there", async () => {
  const { frame, runs, panel } = await openHeld();

  expect(panel.getBoundingClientRect().width).toBeCloseTo(390, 0);
  expect(Math.abs(frame.shift - frame.height), `held ${frame.shift}px down`).toBeLessThanOrEqual(1);
  const matrix = new DOMMatrix(frame.transform === "none" ? undefined : frame.transform);
  expect([matrix.a, matrix.b, matrix.c, matrix.d, matrix.e]).toEqual([1, 0, 0, 1, 0]);
  expect(frame.opacity).toBe(1);
  expect(frame.scrim).toBe(0);

  for (const run of runs) run.play();
  await Promise.all(runs.map((run) => run.finished.catch(() => undefined)));
  const rest = read(panel);
  expect(Math.abs(rest.shift)).toBeLessThanOrEqual(0.5);
  expect(rest.scrim).toBe(1);
});

it("fades in place at 390px under reduced motion, its scrim with it", async () => {
  await commands.emulateMedia({ reducedMotion: "reduce" });
  const { frame, runs, panel } = await openHeld();

  expect(Math.abs(frame.shift), `held ${frame.shift}px down`).toBeLessThanOrEqual(0.5);
  expect(frame.transform).toBe("none");
  expect(frame.opacity).toBe(0);
  expect(frame.scrim).toBe(0);

  for (const run of runs) run.play();
  await Promise.all(runs.map((run) => run.finished.catch(() => undefined)));
  const rest = read(panel);
  expect(rest.transform).toBe("none");
  expect(rest.opacity).toBe(1);
  expect(rest.scrim).toBe(1);
});
