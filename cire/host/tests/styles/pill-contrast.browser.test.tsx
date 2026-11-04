import { contrastRatio, WCAG_TEXT_MIN } from "@cire/theme";
import Button, { type ButtonVariant } from "@cire/ui/button";
import { cardClass } from "@cire/ui/card";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/*
 * Every pill that sits on `--pill-ground` (DESIGN.md §4, One pill language)
 * holds its word to 4.5:1 in this portal's own palette: on the page and on a
 * card, in both themes, at rest and under the pointer, a chosen `choice` and
 * `glass` included. The ground is the surface at 30%, lighter than the page in
 * dark, so a gold or red word loses some of its contrast on it; `@cire/ui`'s
 * own tests measure on their own ramps, which this stylesheet can drift from.
 * Each word is measured against what it is painted over: the page, the card,
 * the pill's own fill — the ground at rest, `danger`'s red wash and `cta`'s
 * gold under the pointer.
 */

const THEMES = ["dark", "light"] as const;

interface Case {
  readonly name: string;
  readonly variant: ButtonVariant;
  readonly pressed?: "true" | "false";
}

const CASES: readonly Case[] = [
  { name: "Call to action", variant: "cta" },
  { name: "Outline", variant: "outline" },
  { name: "Quiet", variant: "quiet" },
  { name: "Quiet danger", variant: "quietDanger" },
  { name: "Danger", variant: "danger" },
  { name: "Dashed", variant: "dashed" },
  { name: "Choice", variant: "choice", pressed: "false" },
  { name: "Choice chosen", variant: "choice", pressed: "true" },
  { name: "Glass", variant: "glass", pressed: "false" },
  { name: "Glass chosen", variant: "glass", pressed: "true" },
];

const GROUNDS = {
  page: (pills: JSX.Element) => <div class="bg-bg flex flex-wrap gap-2 p-4">{pills}</div>,
  card: (pills: JSX.Element) => (
    <div class={cardClass()}>
      <div class="flex flex-wrap gap-2">{pills}</div>
    </div>
  ),
} as const;

/** Colours land at once, so a reading under the pointer is the hover's own. */
const still = document.createElement("style");
still.textContent = "*,*::before,*::after{transition:none!important}";
beforeAll(() => {
  document.head.append(still);
});
afterAll(() => {
  still.remove();
});

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
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  const ground = getComputedStyle(document.documentElement).getPropertyValue("--bg");
  return composite([ground, ...layers]);
}

function ratioOf(pill: Element): number {
  const under = backdropOf(pill);
  return contrastRatio(composite([under, getComputedStyle(pill).color]), under)!;
}

describe("a grounded pill's word in this portal's palette", () => {
  for (const theme of THEMES) {
    for (const [groundName, wrap] of Object.entries(GROUNDS)) {
      it(`reads at ${WCAG_TEXT_MIN}:1 on the ${groundName}, at rest and under the pointer, ${theme}`, async () => {
        document.documentElement.dataset.theme = theme;
        render(() =>
          wrap(
            <>
              {CASES.map((c) => (
                <Button variant={c.variant} aria-pressed={c.pressed}>
                  {c.name}
                </Button>
              ))}
            </>,
          ),
        );
        const short: string[] = [];
        for (const c of CASES) {
          const pill = screen.getByRole("button", { name: c.name });
          await userEvent.unhover(pill);
          const rest = ratioOf(pill);
          if (rest < WCAG_TEXT_MIN) short.push(`${c.name} at rest: ${rest.toFixed(2)}`);
          await userEvent.hover(pill);
          const hover = ratioOf(pill);
          if (hover < WCAG_TEXT_MIN) short.push(`${c.name} under the pointer: ${hover.toFixed(2)}`);
        }
        await userEvent.unhover(screen.getByRole("button", { name: CASES.at(-1)!.name }));
        expect(short).toEqual([]);
      });
    }
  }
});
