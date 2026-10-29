import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { Chip, type ChipTone, type ChipTreatment, type ChipVariant } from "@shared/ui/ui/chip";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/**
 * Every `Chip` the portal can draw — each tone, filled and outlined, in small
 * caps and as a tag — holds its word to 4.5:1 on each ground a chip sits on
 * here, in both themes. A chip's word is small text, and a tint strong enough
 * to show on the pale theme darkens the ground under a coloured word: the
 * gold-dim accent fill measured 3.90:1 in light before its tint went to 8%
 * (owner, englishstreetventures/osn#1836). This is what stops a later fill, or
 * a later ramp, slipping back under the floor.
 *
 * The grounds are the page and a card's wash (the surface at 30%), for every
 * chip, and the run sheet's coming-up row (gold at 8%) for the tones its flags
 * wear — accent, pending and neutral; red on that gold wash reads 4.29:1 in
 * light, and no flag is red. Each ground is painted from the stylesheet's own
 * tokens. `danger` is held to its outline: its filled 10% tint reads 4.01:1 on
 * the pale page with this red, so the one danger tag the portal draws ("No
 * longer available") is an outline, and no screen draws the filled one.
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
  layers: readonly string[];
  tones: readonly ChipTone[];
}

const GROUNDS = {
  page: { layers: [], tones: TONES },
  card: { layers: ["color-mix(in oklab, var(--surface) 30%, transparent)"], tones: TONES },
  "coming-up row": {
    layers: ["color-mix(in oklab, var(--gold) 8%, transparent)"],
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

/** A token's colour as the engine resolves it under the current theme. */
function resolved(css: string): string {
  const probe = document.createElement("span");
  probe.style.backgroundColor = css;
  document.body.append(probe);
  const colour = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return colour;
}

/** Filled danger is the one combination no screen draws; see the note above. */
const DRAWN = (tone: ChipTone, variant: ChipVariant) =>
  !(tone === "danger" && variant === "filled");

describe("Chip contrast on cire's grounds", () => {
  for (const theme of THEMES) {
    for (const [groundName, { layers, tones }] of Object.entries(GROUNDS)) {
      it(`holds every chip's word to ${WCAG_TEXT_MIN}:1 on the ${groundName}, ${theme}`, () => {
        document.documentElement.dataset.theme = theme;
        const ground = composite([resolved("var(--bg)"), ...layers.map(resolved)]);
        const short: string[] = [];
        for (const tone of tones) {
          for (const variant of VARIANTS) {
            if (!DRAWN(tone, variant)) continue;
            for (const treatment of TREATMENTS) {
              const { container, unmount } = render(() => (
                <Chip tone={tone} variant={variant} treatment={treatment}>
                  Word
                </Chip>
              ));
              const style = getComputedStyle(container.firstElementChild!);
              const under = composite([ground, style.backgroundColor]);
              const ratio = contrastRatio(composite([under, style.color]), under)!;
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

  it("measures something: a tint known to fail does fail", () => {
    // The gold-dim fill the accent chip wore before, in light, on the page.
    document.documentElement.dataset.theme = "light";
    const ground = resolved("var(--bg)");
    const under = composite([ground, resolved("var(--gold-dim)")]);
    const ink = resolved("var(--gold-ink)");
    expect(contrastRatio(composite([under, ink]), under)!).toBeLessThan(WCAG_TEXT_MIN);
  });
});
