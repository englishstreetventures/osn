/**
 * `FileInput`, measured in Chromium against cire's two ramps.
 *
 * The button is `::file-selector-button`, a pseudo-element: no box of its own
 * to measure, so its height is read from the input it sets, and its paint from
 * the pseudo-element's computed style — which the first case proves is the
 * button's and not the input's, by giving the two different inks.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import Button from "../src/button";
import { type CardFill, cardClass } from "../src/card";
import FileInput from "../src/file-input";
import { backdropLayers, composite, ratio } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;

afterEach(cleanup);

const button = (input: Element) => getComputedStyle(input, "::file-selector-button");

/** A token's colour as the page resolves it, read off a probe's own style. */
function token(name: string): string {
  const probe = document.createElement("span");
  probe.style.color = `var(${name})`;
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  return color;
}

/** The button's word against what it sits on (it has no fill of its own). */
function buttonInk(input: Element): number {
  const under = backdropLayers(input);
  return ratio(composite([...under, button(input).color]), composite(under));
}

/** The file name's ink against what it sits on. */
function nameInk(input: Element): number {
  const under = backdropLayers(input);
  return ratio(composite([...under, getComputedStyle(input).color]), composite(under));
}

describe("FileInput", () => {
  it("reads the button's own paint, not the input's", () => {
    render(() => <FileInput aria-label="Picture" />);
    const input = screen.getByLabelText("Picture");
    expect(button(input).color).not.toBe(getComputedStyle(input).color);
  });

  it("draws the button as a quiet pill: 34px, 20px sides, the small step, the hairline, no fill", () => {
    render(() => (
      <div style={{ "--ui-radius-control": "999px" }}>
        <FileInput aria-label="Picture" />
      </div>
    ));
    const input = screen.getByLabelText("Picture");
    const b = button(input);
    expect(input.getBoundingClientRect().height).toBe(34);
    expect([b.paddingLeft, b.paddingRight, b.borderTopWidth]).toEqual(["20px", "20px", "1px"]);
    expect(b.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(Number.parseFloat(b.borderTopLeftRadius)).toBeGreaterThanOrEqual(17);
    expect(b.fontSize).toBe(getComputedStyle(input).fontSize);
    expect(b.marginRight).toBe("12px");
    // The body face on the button and the file name, as a `Button` draws it.
    render(() => <Button>Crop</Button>);
    const face = getComputedStyle(screen.getByRole("button")).fontFamily;
    expect([b.fontFamily, getComputedStyle(input).fontFamily]).toEqual([face, face]);
    // `Button`'s colour fade, on the app's `--dur-fast` (90ms here).
    expect(b.transitionProperty).toContain("border-color");
    expect(b.transitionDuration).toBe("0.09s");
  });

  it("turns the edge to the accent under the pointer, and not when disabled", async () => {
    render(() => (
      <>
        <FileInput aria-label="Open" />
        <FileInput aria-label="Shut" disabled />
      </>
    ));
    const open = screen.getByLabelText("Open");
    const shut = screen.getByLabelText("Shut");
    const rest = button(open).borderTopColor;
    await userEvent.hover(open);
    await expect.poll(() => button(open).borderTopColor).toBe(token("--ui-accent"));
    await expect.poll(() => button(open).color).toBe(token("--ui-accent-ink"));
    expect(button(open).cursor).toBe("pointer");
    await userEvent.hover(shut, { force: true });
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect([button(shut).borderTopColor, button(shut).cursor]).toEqual([rest, "not-allowed"]);
    expect(getComputedStyle(shut).opacity).toBe("0.4");
  });

  it("draws the house focus outline on the input under the keyboard", async () => {
    render(() => <FileInput aria-label="Picture" />);
    await userEvent.tab();
    const s = getComputedStyle(screen.getByLabelText("Picture"));
    expect([s.outlineStyle, s.outlineWidth, s.outlineOffset, s.outlineColor]).toEqual([
      "solid",
      "2px",
      "2px",
      token("--ui-focus"),
    ]);
  });

  for (const ramp of RAMPS) {
    for (const fill of [undefined, "wash", "well", "opaque"] as (CardFill | undefined)[]) {
      it(`holds the button's word and the file name at 4.5:1 on ${fill ? `a ${fill} card` : "the page"}, ${ramp}`, () => {
        render(() => (
          <div data-ramp={ramp === "light" ? "light" : undefined} class="bg-ui-ground p-4">
            <div class={fill ? `p-4 ${cardClass({ fill })}` : "p-4"}>
              <FileInput aria-label="Picture" />
            </div>
          </div>
        ));
        const input = screen.getByLabelText("Picture");
        expect([buttonInk(input) >= 4.5, nameInk(input) >= 4.5]).toEqual([true, true]);
      });
    }
  }
});
