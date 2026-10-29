import { contrastRatio, PALETTE_PRESET_KEYS, WCAG_TEXT_MIN } from "@cire/theme";
import { Notice, type NoticeTone } from "@shared/ui/ui/notice";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";
import { applyPaletteToRoot } from "../../src/components/invite-theme";

/**
 * The RSVP sheet's closed note (`info`) lays the surface at 30% under its
 * muted ink, a backdrop the palette's own pairs never measure. This holds its
 * words to 4.5:1 on every ground a note sits on — the page, the surface and the
 * raised surface — in every colour scheme a couple can pick.
 *
 * The preview notes (`accent`) are not measured here: their 5% gold under
 * readable gold reads 4.34–4.50:1 on the page or a raised surface in three of
 * the schemes, as the hand-drawn box they replace did; whether to lift that
 * tint is a choice of look for the owner.
 */

const TONES = ["info"] as const satisfies readonly NoticeTone[];
const GROUNDS = {
  page: "bg-bg",
  surface: "bg-surface",
  "raised surface": "bg-surface-raised",
} as const;

/** Paint `layers` bottom-up on a 1px canvas and read back plain `rgb`. */
function composite(layers: readonly string[]): string {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return `rgb(${r}, ${g}, ${b})`;
}

afterEach(() => {
  cleanup();
  applyPaletteToRoot(null);
  const root = document.documentElement;
  for (const name of Array.from(root.style)) {
    if (name.startsWith("--")) root.style.removeProperty(name);
  }
});

describe.each(PALETTE_PRESET_KEYS)("the %s scheme", (palettePreset) => {
  it("holds the closed note's words to 4.5:1 on every ground", () => {
    applyPaletteToRoot({ palettePreset, headingFont: null, bodyFont: null });
    const short: string[] = [];
    for (const [groundName, ground] of Object.entries(GROUNDS)) {
      for (const tone of TONES) {
        const { container, unmount } = render(() => (
          <div class={ground}>
            <Notice size="sm" tone={tone}>
              RSVPs have closed.
            </Notice>
          </div>
        ));
        const wrap = container.firstElementChild!;
        const box = wrap.firstElementChild!;
        const page = getComputedStyle(document.documentElement).getPropertyValue("--color-bg");
        const under = composite([
          page,
          getComputedStyle(wrap).backgroundColor,
          getComputedStyle(box).backgroundColor,
        ]);
        const ratio = contrastRatio(composite([under, getComputedStyle(box).color]), under)!;
        if (ratio < WCAG_TEXT_MIN) short.push(`${tone} on the ${groundName}: ${ratio.toFixed(2)}`);
        unmount();
      }
    }
    expect(short).toEqual([]);
  });
});
