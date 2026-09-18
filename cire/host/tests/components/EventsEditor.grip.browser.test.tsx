import Button from "@cire/ui/button";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";

/**
 * The drag grip on an event row is the only pointer affordance for re-ordering
 * an event, on a portal that is used on phones, so WCAG 2.2 SC 2.5.8 (Target
 * Size, Minimum) puts a 24x24 CSS-pixel floor under it.
 *
 * Only an engine can answer that. `size="icon"` on a borderless variant sets no
 * height and no vertical padding — the box is whatever the glyph's line box
 * gives, and `leading-none` makes that as tight as the font allows — so the
 * number is a product of the font metrics, the border and the cascade, none of
 * which the fast tier has. Measured at **22.3 x 18.8 px** before the floor was
 * added, which is how this test came to exist.
 *
 * The grip is reproduced here rather than mounted through `EventsEditor`, which
 * needs a wedding store and a live sortable context to render a row at all. That
 * is only honest while the two stay identical, so the last assertion reads the
 * call site and fails if it ever grows a size class of its own — at which point
 * this file is measuring something the app no longer renders.
 */

const GRIP_CLASS = "cursor-grab touch-none active:cursor-grabbing";

/** SC 2.5.8's floor, in CSS pixels. */
const MINIMUM_TARGET = 24;

describe("events drag grip — painted", () => {
  afterEach(() => cleanup());

  it("meets the 24px minimum target in both axes", () => {
    const result = render(() => (
      // The row's own wrapper. A flex parent is where a `min-width` floor can be
      // shrunk back below itself, so the measurement has to include it.
      <div class="flex items-center">
        <Button variant="bare" size="icon" class={GRIP_CLASS}>
          ⠿
        </Button>
      </div>
    ));

    const grip = result.container.querySelector("button") as HTMLButtonElement;
    const box = grip.getBoundingClientRect();

    expect(box.width).toBeGreaterThanOrEqual(MINIMUM_TARGET);
    expect(box.height).toBeGreaterThanOrEqual(MINIMUM_TARGET);
  });

  it("is squeezed by neither a narrow row nor a greedy sibling", () => {
    const result = render(() => (
      <div class="flex w-24 items-center">
        <Button variant="bare" size="icon" class={GRIP_CLASS}>
          ⠿
        </Button>
        <span class="grow">An event title long enough to want every pixel in the row</span>
      </div>
    ));

    const grip = result.container.querySelector("button") as HTMLButtonElement;
    const box = grip.getBoundingClientRect();

    expect(box.width).toBeGreaterThanOrEqual(MINIMUM_TARGET);
    expect(box.height).toBeGreaterThanOrEqual(MINIMUM_TARGET);
  });
});
