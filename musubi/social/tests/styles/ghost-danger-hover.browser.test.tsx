import { Button } from "@shared/ui/ui/button";
import { Card } from "@shared/ui/ui/card";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import "../../src/App.css";

/**
 * A hovered `ghostDanger` Button (Connections' Remove and Cancel, an
 * organisation roster's Remove) keeps red text at 4.5:1 or better against
 * what it stands on, in both themes. `DESIGN.md` §Status colours puts red text
 * "on the page, a card or a popover, never on `--muted`", so the variant takes
 * no hover fill; this reads the real computed colours with the pointer on the
 * button, over Musubi's own tokens: the button's ink, and the colours painted
 * behind it up the tree, down to the page. A row that tints under the pointer
 * (`hover:bg-muted/50`, as Connections' rows do) is one of the grounds, since
 * the pointer on the button is on the row too.
 */

type Rgb = [number, number, number];

/** The sRGB pixel a stack of CSS colours paints, the first at the bottom. */
function paint(layers: readonly string[]): Rgb {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d")!;
  for (const layer of layers) {
    ctx.fillStyle = layer;
    ctx.fillRect(0, 0, 1, 1);
  }
  const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
  return [r!, g!, b!];
}

function luminance([r, g, b]: Rgb): number {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Jump every running transition to its end, so no value is read part-way. */
function settle() {
  for (const animation of document.getAnimations()) animation.finish();
}

/** What is painted behind `element`'s text: its own fill over every ancestor's, over the page's. */
function behind(element: HTMLElement): Rgb {
  const layers: string[] = [];
  for (let el: HTMLElement | null = element; el; el = el.parentElement) {
    layers.unshift(getComputedStyle(el).backgroundColor);
  }
  return paint(["#ffffff", ...layers]);
}

afterEach(() => {
  cleanup();
  document.documentElement.classList.remove("dark");
});

describe.each([
  ["light", false],
  ["dark", true],
] as const)("a hovered ghostDanger Button, %s", (theme, dark) => {
  it.each([
    ["the page", "page"],
    ["a card", "card"],
    ["a hovered row", "row"],
  ] as const)("on %s keeps its red text at 4.5:1 and paints no fill", async (_where, ground) => {
    document.documentElement.classList.toggle("dark", dark);
    const remove = () => (
      <Button variant="ghostDanger" size="sm">
        Remove
      </Button>
    );
    render(() => (
      <div class="bg-background">
        {ground === "card" ? <Card padding="sm">{remove()}</Card> : null}
        {ground === "row" ? (
          // The row Connections and an organisation's roster draw, which tints on hover.
          <div class="hover:bg-muted/50 active:bg-muted/50 flex items-center gap-3 rounded-lg px-3 py-2.5">
            {remove()}
          </div>
        ) : null}
        {ground === "page" ? remove() : null}
      </div>
    ));
    const button = screen.getByRole("button", { name: "Remove" });
    await userEvent.hover(button);
    settle();
    expect(button.matches(":hover")).toBe(true);

    const style = getComputedStyle(button);
    expect([theme, style.backgroundColor]).toEqual([theme, "rgba(0, 0, 0, 0)"]);
    const ratio = contrast(paint([style.color]), behind(button));
    expect([theme, ratio >= 4.5]).toEqual([theme, true]);
  });
});
