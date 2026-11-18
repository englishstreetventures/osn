/**
 * `Modal`'s backdrop in the portal is the deep ground at 72%, in both themes.
 *
 * `Modal` paints its `::backdrop` with the contract's scrim role, `--ui-scrim`,
 * whose fallback is black at 50%. This stylesheet maps the role onto
 * `color-mix(in srgb, var(--ui-ground-deep) 72%, transparent)`. So each theme's
 * case compares the painted backdrop with a probe painted that expression: it
 * fails if the mapping is dropped (black at 50%) or names another colour. The
 * probe reads the same ground as the backdrop, so it cannot see a theme that
 * stops reaching it; the last case can, because the two themes' grounds differ.
 * Only an engine resolves `::backdrop` and the `var()` chain under it.
 */

import { Modal } from "@shared/ui/ui/modal";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("data-theme");
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

/** Open a `Modal` under `theme`, screenshot it, and hand back its backdrop's colour. */
async function backdropIn(theme: "dark" | "light"): Promise<string> {
  // What the boot script writes on `<html>` before first paint.
  document.documentElement.setAttribute("data-theme", theme);
  render(() => (
    <Modal open onClose={() => {}} label="Remove guest">
      <p>Inside</p>
    </Modal>
  ));
  const dialog = await screen.findByRole("dialog", { name: "Remove guest" });
  for (const animation of dialog.getAnimations({ subtree: true })) animation.finish();
  await page.screenshot({ path: `__screenshots__/modal-scrim.browser.test.tsx/${theme}.png` });
  return getComputedStyle(dialog, "::backdrop").backgroundColor;
}

describe("Modal's backdrop in the portal", () => {
  it.each([["dark"], ["light"]] as const)("is the deep ground at 72%% in %s", async (theme) => {
    const backdrop = await backdropIn(theme);
    expect(backdrop).toBe(paint(DEEP_GROUND_72));
    expect(backdrop).not.toBe(paint("rgb(0 0 0 / 0.5)"));
  });

  it("follows the theme: dark and light paint different backdrops", async () => {
    const dark = await backdropIn("dark");
    cleanup();
    const light = await backdropIn("light");
    expect(light).not.toBe(dark);
  });
});
