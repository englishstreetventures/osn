/**
 * `Modal`'s backdrop on the guest site is the invite's deep ground at 72%.
 *
 * `Modal` paints its `::backdrop` with the contract's scrim role, `--ui-scrim`,
 * whose fallback is black at 50%. This stylesheet maps the role onto
 * `color-mix(in srgb, var(--ui-ground-deep) 72%, transparent)`, and an invite's palette is written onto
 * `<html>` beside that mapping. So each case compares the painted backdrop with
 * a probe painted that expression, under the built-in palette and under one an
 * organiser chose. `AnimatedModal` also sets a section's tokens on the panel
 * itself, which must not move the backdrop: the third case sets one there.
 */

import { Modal } from "@shared/ui/ui/modal";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { applyPaletteToRoot } from "../../src/components/invite-theme";

import "../../src/styles/global.css";

afterEach(() => {
  cleanup();
  applyPaletteToRoot(null);
});

/** The colour `value` paints, resolved by the engine on a probe under `<body>`. */
function paint(value: string): string {
  const probe = document.createElement("div");
  probe.style.backgroundColor = value;
  document.body.append(probe);
  const computed = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return computed;
}

/** The deep ground at 72%, the backdrop cire's mapping of `--ui-scrim` paints. */
const DEEP_GROUND_72 = "color-mix(in srgb, var(--ui-ground-deep, #18181b) 72%, transparent)";

describe("Modal's backdrop on the guest site", () => {
  it.each([
    ["the built-in palette", null, undefined],
    ["the jewel palette", "jewel", undefined],
    ["a section's ground on the panel", "jewel", { "--color-bg": "oklch(90% 0.02 90)" }],
  ] as const)("is the deep ground at 72%% under %s", async (name, palettePreset, panel) => {
    if (palettePreset) applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });
    render(() => (
      <Modal open onClose={() => {}} label="Your reply" style={panel}>
        <p>Inside</p>
      </Modal>
    ));
    const dialog = await screen.findByRole("dialog", { name: "Your reply" });
    for (const animation of dialog.getAnimations({ subtree: true })) animation.finish();
    await page.screenshot({
      path: `__screenshots__/modal-scrim.browser.test.tsx/${name.replaceAll(" ", "-")}.png`,
    });

    const backdrop = getComputedStyle(dialog, "::backdrop").backgroundColor;
    expect(backdrop).toBe(paint(DEEP_GROUND_72));
    expect(backdrop).not.toBe(paint("rgb(0 0 0 / 0.5)"));
  });
});
