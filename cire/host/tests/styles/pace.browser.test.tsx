import { Modal } from "@shared/ui/ui/modal";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";

import "../../src/styles/global.css";

// `Modal` (`@shared/ui`) at the portal's pace. It takes its two durations from
// `--ui-modal-enter` and `--ui-modal-exit`, which host sets from its own ladder
// under `(pointer: fine)` only: a desk opens a dialog in 200ms, a phone keeps
// `Modal`'s own longer defaults. The close is the exception: host's desk exit,
// `--dur-base`, equals `Modal`'s own, so desk and touch close alike and the
// exit needs no touch rung (the owner's set A, englishstreetventures/osn#2079).
// Only an engine resolves the variable chain and the pointer query, so this
// reads the running transitions back.

/** The longest transition running on the open dialog, in ms. */
async function openingMs() {
  render(() => (
    <Modal open onClose={() => {}} label="Paced">
      <p>Inside</p>
    </Modal>
  ));
  const dialog = await screen.findByRole("dialog", { name: "Paced" });
  await new Promise(requestAnimationFrame);
  const ms = Math.max(
    ...dialog.getAnimations().map((a) => Number(a.effect!.getComputedTiming().duration)),
  );
  cleanup();
  return ms;
}

/** The longest transition running on a dialog as it closes, its backdrop included, in ms. */
async function closingMs() {
  const [open, setOpen] = createSignal(true);
  render(() => (
    <Modal open={open()} onClose={() => setOpen(false)} label="Closing">
      <p>Inside</p>
    </Modal>
  ));
  const dialog = await screen.findByRole("dialog", { name: "Closing" });
  await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
  setOpen(false);
  const ms = Math.max(
    ...dialog
      .getAnimations({ subtree: true })
      .map((a) => Number(a.effect!.getComputedTiming().duration)),
  );
  await Promise.all(dialog.getAnimations({ subtree: true }).map((a) => a.finished));
  cleanup();
  return ms;
}

afterEach(() => cleanup());

describe("a dialog's pace follows the input", () => {
  it("opens in 200ms with a mouse, and on Modal's own defaults on touch", async () => {
    expect(matchMedia("(pointer: fine)").matches).toBe(true);
    expect(await openingMs()).toBe(200);

    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    try {
      expect(matchMedia("(pointer: coarse)").matches).toBe(true);
      // `Modal`'s defaults: 250ms for the fade, 350ms for the rise.
      expect(await openingMs()).toBe(350);
    } finally {
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
  });

  it("closes in the same time with a mouse and on touch", async () => {
    expect(matchMedia("(pointer: fine)").matches).toBe(true);
    const desk = await closingMs();
    expect(desk).toBe(150);

    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    try {
      expect(matchMedia("(pointer: coarse)").matches).toBe(true);
      // `Modal`'s own exit, which no host rule overrides on touch.
      expect(await closingMs()).toBe(desk);
    } finally {
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
  });
});
