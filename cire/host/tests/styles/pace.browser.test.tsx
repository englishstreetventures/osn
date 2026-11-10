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
//
// Every reading with the fine pointer comes before the touch ones, and touch
// emulation goes on once, in the file's last test: once it has been on and off
// again, the Linux Chromium CI runs no longer matches `(pointer: fine)`.

/** Which primary pointer the page reports, so a failure names the one it got. */
function primaryPointer() {
  return (["fine", "coarse", "none"] as const).find((p) => matchMedia(`(pointer: ${p})`).matches);
}

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

/**
 * The longest transition running on a settled dialog as it closes, its
 * backdrop included, in ms. Waits for the exit to end before it unmounts.
 */
async function closingMs() {
  const [open, setOpen] = createSignal(true);
  render(() => (
    <Modal open={open()} onClose={() => setOpen(false)} label="Closing">
      <p>Inside</p>
    </Modal>
  ));
  const dialog = await screen.findByRole("dialog", { name: "Closing" });
  const running = () => dialog.getAnimations({ subtree: true });
  await Promise.all(running().map((a) => a.finished));
  setOpen(false);
  const ms = Math.max(...running().map((a) => Number(a.effect!.getComputedTiming().duration)));
  await Promise.all(running().map((a) => a.finished));
  cleanup();
  return ms;
}

afterEach(() => cleanup());

describe("a dialog's pace follows the input", () => {
  it("opens in 200ms and closes in 150ms with a mouse", async () => {
    expect(primaryPointer()).toBe("fine");
    expect(await openingMs()).toBe(200);
    expect(await closingMs()).toBe(150);
  });

  it("opens on Modal's own defaults on touch, and closes in the same 150ms as a mouse", async () => {
    await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
    try {
      expect(primaryPointer()).toBe("coarse");
      // `Modal`'s defaults: 250ms for the fade, 350ms for the rise.
      expect(await openingMs()).toBe(350);
      // `Modal`'s own exit, which no host rule overrides on touch.
      expect(await closingMs()).toBe(150);
    } finally {
      await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
    }
  });
});
