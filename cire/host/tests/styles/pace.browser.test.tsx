import { Modal } from "@shared/ui/ui/modal";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { cdp } from "vitest/browser";

import "../../src/styles/global.css";

// `Modal` (`@shared/ui`) at the portal's pace. It takes its two durations from
// `--ui-modal-enter` and `--ui-modal-exit`, which host sets from its own ladder
// under `(pointer: fine)` only: a desk opens a dialog in 200ms, a phone keeps
// `Modal`'s own longer defaults. Only an engine resolves the variable chain
// and the pointer query, so this reads the running transitions back.

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
});
