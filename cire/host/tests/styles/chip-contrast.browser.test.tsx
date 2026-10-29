import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cardClass } from "@cire/ui/card";
import { Chip, type ChipTone, type ChipTreatment, type ChipVariant } from "@shared/ui/ui/chip";
import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/**
 * Every `Chip` the portal draws — each tone, filled and outlined, in small caps
 * and as a tag — holds its word to 4.5:1 on each ground a chip sits on here, in
 * both themes. A chip's word is small text, and a tint strong enough to show on
 * the pale theme darkens the ground under a coloured word: the gold-dim accent
 * fill measured 3.90:1 in light before its tint went to 8% (owner,
 * englishstreetventures/osn#1836). This is what stops a later fill, or a later
 * ramp, slipping back under the floor.
 *
 * The grounds are the page, `@cire/ui`'s card (its own classes, so a change to
 * its wash is measured here), and a row on the run sheet's coming-up wash
 * (`bg-gold/8`, the class `RunSheetView` paints; `RunSheetView.browser.test.tsx`
 * measures its real rows). The coming-up row is measured for the tones its flags
 * wear — accent, pending, neutral — since no flag is red, and red on that gold
 * reads 4.29:1 in light.
 *
 * Filled `danger` is left out of the floor and held under it instead: its 10%
 * tint reads 4.01:1 on the pale page with cire's red, and no wash of that red
 * reaches 4.5:1, so the portal draws a danger chip outlined (owner, #1836). The
 * last test fails if that ever stops being true, so the exclusion is looked at
 * again.
 */

const THEMES = ["light", "dark"] as const;
const TONES = [
  "neutral",
  "success",
  "pending",
  "accent",
  "danger",
] as const satisfies readonly ChipTone[];
const VARIANTS = ["filled", "outline"] as const satisfies readonly ChipVariant[];
const TREATMENTS = ["caps", "tag"] as const satisfies readonly ChipTreatment[];

interface Ground {
  wrap: (chip: JSX.Element) => JSX.Element;
  tones: readonly ChipTone[];
}

const GROUNDS = {
  page: { wrap: (chip) => <div>{chip}</div>, tones: TONES },
  card: { wrap: (chip) => <div class={cardClass()}>{chip}</div>, tones: TONES },
  "coming-up row": {
    wrap: (chip) => <div class="bg-gold/8">{chip}</div>,
    tones: ["accent", "pending", "neutral"],
  },
} as const satisfies Record<string, Ground>;

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

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

/** What `element` paints its word over: the page's ground, then every
 *  background from the outermost ancestor in, its own last. */
function backdropOf(element: Element): string {
  const layers: string[] = [];
  for (let node: Element | null = element; node; node = node.parentElement) {
    layers.push(getComputedStyle(node).backgroundColor);
  }
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  return composite([ground, ...layers.toReversed()]);
}

/** The chip's word against what it is painted over. */
function ratioOf(chip: Element): number {
  const under = backdropOf(chip);
  return contrastRatio(composite([under, getComputedStyle(chip).color]), under)!;
}

/** Filled danger is held under the floor instead; see the note above. */
const FLOORED = (tone: ChipTone, variant: ChipVariant) =>
  !(tone === "danger" && variant === "filled");

describe("Chip contrast on cire's grounds", () => {
  for (const theme of THEMES) {
    for (const [groundName, { wrap, tones }] of Object.entries(GROUNDS)) {
      it(`holds every chip's word to ${WCAG_TEXT_MIN}:1 on the ${groundName}, ${theme}`, () => {
        document.documentElement.dataset.theme = theme;
        const short: string[] = [];
        for (const tone of tones) {
          for (const variant of VARIANTS) {
            if (!FLOORED(tone, variant)) continue;
            for (const treatment of TREATMENTS) {
              const { container, unmount } = render(() =>
                wrap(
                  <Chip tone={tone} variant={variant} treatment={treatment}>
                    Word
                  </Chip>,
                ),
              );
              const ratio = ratioOf(container.firstElementChild!.firstElementChild!);
              if (ratio < WCAG_TEXT_MIN) {
                short.push(`${tone} ${variant} ${treatment}: ${ratio.toFixed(2)}`);
              }
              unmount();
            }
          }
        }
        expect(short).toEqual([]);
      });
    }
  }

  it("still finds filled danger under the floor on the pale page, which is why no screen draws it", () => {
    document.documentElement.dataset.theme = "light";
    const { container } = render(() => (
      <div>
        <Chip tone="danger" treatment="tag">
          No longer available
        </Chip>
      </div>
    ));
    expect(ratioOf(container.firstElementChild!.firstElementChild!)).toBeLessThan(WCAG_TEXT_MIN);
  });
});
