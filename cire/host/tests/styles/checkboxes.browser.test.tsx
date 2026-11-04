import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../src/styles/global.css";

/**
 * An unchecked checkbox or radio is drawn to sit on its surface: no fill of its
 * own and the strong hairline for an edge. A checked one is left to the browser,
 * whose filled box and tick read as a form control (owner, 2026-10-29;
 * DESIGN.md §4). Ticking must change neither the box's size nor where it sits.
 *
 * The rule is in `global.css`'s base layer, which happy-dom never applies, and
 * the native box has a size no stylesheet states — so only a browser can say
 * what an unchecked box paints and that a checked one is the same size.
 */

const THEMES = ["light", "dark"] as const;

afterEach(() => {
  cleanup();
  delete document.documentElement.dataset.theme;
});

/** `--ui-hairline-strong` as the engine resolves it, by painting it on a probe. */
function hairlineStrong(): string {
  const probe = document.createElement("div");
  probe.style.borderTop = "1px solid var(--ui-hairline-strong)";
  document.body.append(probe);
  const colour = getComputedStyle(probe).borderTopColor;
  probe.remove();
  return colour;
}

function look(el: HTMLElement) {
  const style = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  return {
    appearance: style.appearance,
    background: style.backgroundColor,
    border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
    width: box.width,
    height: box.height,
  };
}

function Boxes() {
  return (
    <div class="bg-bg text-text flex flex-col gap-3 p-4">
      <label class="flex items-center gap-2">
        <input type="checkbox" aria-label="plain unchecked" />
        Plain
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" checked aria-label="plain checked" />
        Plain, ticked
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" class="h-4 w-4" aria-label="sized unchecked" />
        Sized
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" class="h-4 w-4" checked aria-label="sized checked" />
        Sized, ticked
      </label>
      <label class="flex items-center gap-2">
        <input type="radio" name="r" aria-label="radio unchecked" />
        Radio
      </label>
      <label class="flex items-center gap-2">
        <input type="radio" name="r" checked aria-label="radio checked" />
        Radio, chosen
      </label>
      <label class="flex items-center gap-2">
        <input type="checkbox" disabled aria-label="disabled unchecked" />
        Disabled
      </label>
      <label class="flex items-center gap-2">
        <input type="radio" name="d" disabled aria-label="radio disabled" />
        Radio, disabled
      </label>
      <label class="flex items-center gap-2">
        <input
          type="checkbox"
          aria-label="indeterminate"
          ref={(el) => {
            el.indeterminate = true;
          }}
        />
        Some of them
      </label>
      <p>
        Inline in a sentence <input type="checkbox" aria-label="inline" /> before and after.
      </p>
    </div>
  );
}

describe("native checkboxes and radios", () => {
  for (const theme of THEMES) {
    it(`draw the unchecked box on its surface and leave the checked one native, ${theme}`, async () => {
      await page.viewport(600, 500);
      document.documentElement.dataset.theme = theme;
      render(() => <Boxes />);
      const edge = `1px solid ${hairlineStrong()}`;
      const get = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

      for (const name of ["plain unchecked", "sized unchecked", "radio unchecked"]) {
        expect({ name, ...look(get(name)) }).toMatchObject({
          name,
          appearance: "none",
          background: "rgba(0, 0, 0, 0)",
          border: edge,
        });
      }
      for (const name of ["plain checked", "sized checked", "radio checked"]) {
        expect({ name, appearance: look(get(name)).appearance }).toEqual({
          name,
          appearance: "auto",
        });
      }

      // The same box either way: the native one's size, or the call site's.
      const size = (name: string) => {
        const { width, height } = look(get(name));
        return { width, height };
      };
      expect(size("plain unchecked")).toEqual(size("plain checked"));
      expect(size("sized unchecked")).toEqual({ width: 16, height: 16 });
      expect(size("sized unchecked")).toEqual(size("sized checked"));
      expect(size("radio unchecked")).toEqual(size("radio checked"));
      expect(getComputedStyle(get("radio unchecked")).borderTopLeftRadius).toBe("50%");

      // Ticking moves nothing, in a row or in a line of text.
      for (const name of ["plain unchecked", "inline"]) {
        const box = get(name);
        const before = box.getBoundingClientRect();
        box.click();
        expect(box.checked).toBe(true);
        const after = box.getBoundingClientRect();
        expect({ name, x: after.x, y: after.y }).toEqual({ name, x: before.x, y: before.y });
        box.click();
      }

      await page.screenshot({
        path: `__screenshots__/checkboxes.browser.test.tsx/boxes-${theme}.png`,
      });
    });
  }

  it("dims a disabled unchecked box, leaves an indeterminate one native, and darkens the edge on hover", async () => {
    await page.viewport(600, 500);
    render(() => <Boxes />);
    const get = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

    // `appearance: none` drops the browser's own grey, so the dimming is the
    // only thing that tells a disabled box from a live one.
    for (const name of ["disabled unchecked", "radio disabled"]) {
      const style = getComputedStyle(get(name));
      expect({ name, appearance: style.appearance, opacity: style.opacity }).toEqual({
        name,
        appearance: "none",
        opacity: "0.4",
      });
    }
    expect(getComputedStyle(get("plain unchecked")).opacity).toBe("1");

    // A box with some of its group ticked is the browser's dash.
    expect(get("indeterminate").indeterminate).toBe(true);
    expect(getComputedStyle(get("indeterminate")).appearance).toBe("auto");

    // The edge goes from the hairline to the secondary ink under the pointer.
    const probe = document.createElement("div");
    probe.style.borderTop = "1px solid var(--ui-ink-secondary)";
    document.body.append(probe);
    const secondary = getComputedStyle(probe).borderTopColor;
    probe.remove();
    const box = get("plain unchecked");
    expect(getComputedStyle(box).borderTopColor).toBe(hairlineStrong());
    await userEvent.hover(box);
    await vi.waitFor(() => expect(getComputedStyle(box).borderTopColor).toBe(secondary));
    await userEvent.hover(get("disabled unchecked"));
    await vi.waitFor(() =>
      expect(getComputedStyle(get("disabled unchecked")).borderTopColor).toBe(hairlineStrong()),
    );
  });
});
