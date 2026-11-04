import { derivePalette, PALETTE_PRESET_KEYS } from "@cire/theme";
import DietaryPresets from "@cire/ui/dietary-presets";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/*
 * A ticked dietary pill on every built-in scheme a couple can choose: its
 * word, in the readable gold `choice` marks a chosen answer with, at 4.5:1 on
 * the page and on the sheet's card, wherever the scheme puts them. The
 * portals' ramps and the marketing site's ground are measured in `@cire/ui`
 * (`tests/dietary-presets.browser.test.tsx`); this is the guest's side, whose
 * colours `derivePalette` makes from the couple's five.
 */

/** The guest page sets a scheme's colours on the root, where `--ui-*` reads them. */
function applyScheme(scheme: string): void {
  for (const [name, value] of Object.entries(derivePalette(null, scheme))) {
    document.documentElement.style.setProperty(name, value);
  }
}

afterEach(() => {
  cleanup();
  document.documentElement.removeAttribute("style");
});

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** Paint `layers` bottom-up on a 1px canvas and read back `[r, g, b]`. */
function paint(layers: readonly string[]): [number, number, number] {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
  return [r, g, b];
}

function contrast(first: readonly number[], second: readonly number[]): number {
  const lum = ([r, g, b]: readonly number[]) =>
    0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  const [x, y] = [lum(first), lum(second)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

describe("a ticked dietary pill", () => {
  for (const scheme of PALETTE_PRESET_KEYS) {
    for (const ground of ["bg-bg", "bg-surface"] as const) {
      it(`reads at 4.5:1 on ${scheme}'s ${ground === "bg-bg" ? "page" : "card"}`, () => {
        applyScheme(scheme);
        render(() => (
          <div class={`${ground} p-4`}>
            <DietaryPresets value={["vegan"]} onChange={() => {}} wrap />
          </div>
        ));
        const pill = screen.getByRole("checkbox", { name: "Vegan" }).closest("label")!;
        const under = getComputedStyle(pill.parentElement!.closest(`.${ground}`)!).backgroundColor;
        const word = getComputedStyle(pill).color;
        expect(contrast(paint([under, word]), paint([under]))).toBeGreaterThanOrEqual(4.5);
      });
    }
  }
});
