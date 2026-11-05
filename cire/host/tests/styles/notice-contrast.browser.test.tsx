import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import { cardClass } from "@cire/ui/card";
import Note from "@cire/ui/note";
import { Notice, type NoticeSize, type NoticeTone } from "@shared/ui/ui/notice";
import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/**
 * Every `Notice` tone and `@cire/ui`'s `Note` hold their words to 4.5:1 on each
 * ground the portal sets a notice on, at each size, in both themes. A boxed
 * notice lays a tint of its tone under its own ink, so a ground that passes for
 * the bare ink can fail once the tint is on it; this measures the composite.
 *
 * The grounds are the page, `@cire/ui`'s card at its wash, opaque and well
 * fills (its own classes), the raised surface a menu or a sheet sits on, and a
 * row on the run sheet's coming-up wash (`bg-gold/8`). `--bg-deep`, what the
 * page recedes to under a scrim, is left out: the gold note reads 4.35:1 on it
 * in light, so no note is set there, and the last test holds that fact so the
 * exclusion is looked at again if it changes.
 *
 * `danger` is measured with the rest. Its worst ground is a card's well, where
 * the light ramp's red reads 4.63:1 with its 5% box on and 5.00:1 as a line;
 * that well is why the light red sits at L 46%.
 */

const THEMES = ["light", "dark"] as const;
const TONES = [
  "danger",
  "warn",
  "success",
  "info",
  "accent",
] as const satisfies readonly NoticeTone[];
const SIZES = ["inline", "sm", "md"] as const satisfies readonly NoticeSize[];

const GROUNDS = {
  page: (n: JSX.Element) => <div>{n}</div>,
  "card wash": (n: JSX.Element) => <div class={cardClass()}>{n}</div>,
  "opaque card": (n: JSX.Element) => <div class={cardClass({ fill: "opaque" })}>{n}</div>,
  "card well": (n: JSX.Element) => <div class={cardClass({ fill: "well" })}>{n}</div>,
  "raised surface": (n: JSX.Element) => <div class="bg-surface-raised">{n}</div>,
  "coming-up row": (n: JSX.Element) => <div class="bg-gold/8">{n}</div>,
} as const satisfies Record<string, (n: JSX.Element) => JSX.Element>;

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

/** The notice's words against everything painted under them, from the page in. */
function ratioOf(box: Element): number {
  const layers: string[] = [];
  for (let node: Element | null = box; node; node = node.parentElement) {
    layers.push(getComputedStyle(node).backgroundColor);
  }
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  const under = composite([ground, ...layers.toReversed()]);
  return contrastRatio(composite([under, getComputedStyle(box).color]), under)!;
}

describe("Notice and Note contrast on cire's grounds", () => {
  for (const theme of THEMES) {
    for (const [groundName, wrap] of Object.entries(GROUNDS)) {
      it(`holds every notice's words to ${WCAG_TEXT_MIN}:1 on the ${groundName}, ${theme}`, () => {
        document.documentElement.dataset.theme = theme;
        const short: string[] = [];
        const measure = (name: string, node: () => JSX.Element) => {
          const { container, unmount } = render(() => wrap(node()));
          const ratio = ratioOf(container.firstElementChild!.firstElementChild!);
          if (ratio < WCAG_TEXT_MIN) short.push(`${name}: ${ratio.toFixed(2)}`);
          unmount();
        };
        for (const size of SIZES) {
          for (const tone of TONES) {
            measure(`${tone} ${size}`, () => (
              <Notice tone={tone} size={size}>
                Words
              </Notice>
            ));
          }
          measure(`Note ${size}`, () => <Note size={size}>Words</Note>);
        }
        expect(short).toEqual([]);
      });
    }
  }

  it("still finds the gold note under the floor on the receded ground, which is why none is set there", () => {
    document.documentElement.dataset.theme = "light";
    const { container } = render(() => (
      <div class="bg-bg-deep">
        <Note>Words</Note>
      </div>
    ));
    expect(ratioOf(container.firstElementChild!.firstElementChild!)).toBeLessThan(WCAG_TEXT_MIN);
  });
});
