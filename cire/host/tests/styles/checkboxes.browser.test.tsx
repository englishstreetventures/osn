import { Checkbox } from "@shared/ui/ui/checkbox";
import { RadioGroup, RadioGroupItem } from "@shared/ui/ui/radio-group";
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

/** Every property the base rule sets, as the engine computed it. */
function ruled(el: HTMLElement) {
  const s = getComputedStyle(el);
  const box = el.getBoundingClientRect();
  return {
    appearance: s.appearance,
    width: box.width,
    height: box.height,
    border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
    radius: s.borderTopLeftRadius,
    background: s.backgroundColor,
    opacity: s.opacity,
    transition: `${s.transitionProperty} ${s.transitionDuration}`,
  };
}

/** `name`'s ink against the ground it sits on, both composited, as a WCAG ratio. */
function inkRatio(el: HTMLElement): number {
  const layers: string[] = [];
  for (let node: Element | null = el; node; node = node.parentElement) {
    layers.unshift(getComputedStyle(node).backgroundColor);
  }
  const paint = (all: string[]) => {
    const c = document.createElement("canvas");
    c.width = c.height = 1;
    const ctx = c.getContext("2d")!;
    for (const layer of all) {
      ctx.fillStyle = layer;
      ctx.fillRect(0, 0, 1, 1);
    }
    const [r = 0, g = 0, b = 0] = ctx.getImageData(0, 0, 1, 1).data;
    return [r, g, b].map((v) => {
      const x = v / 255;
      return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    });
  };
  const lum = ([r, g, b]: number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  const ground = lum(paint(layers));
  const ink = lum(paint([...layers, getComputedStyle(el).color]));
  return (Math.max(ground, ink) + 0.05) / (Math.min(ground, ink) + 0.05);
}

describe("@shared/ui's Checkbox and RadioGroup with box=native", () => {
  for (const theme of THEMES) {
    it(`draw the box the base rule draws on a bare input, unticked, ticked and disabled, ${theme}`, async () => {
      await page.viewport(600, 500);
      document.documentElement.dataset.theme = theme;
      render(() => (
        <div class="bg-bg text-text flex flex-col items-start gap-3 p-4">
          <input type="checkbox" aria-label="bare box" />
          <Checkbox box="native" checked={false} aria-label="part box" />
          <input type="checkbox" checked aria-label="bare ticked" />
          <Checkbox box="native" checked aria-label="part ticked" />
          <input type="checkbox" disabled aria-label="bare disabled" />
          <Checkbox box="native" checked={false} disabled aria-label="part disabled" />
          <input type="radio" name="bare" aria-label="bare radio" />
          <RadioGroup box="native" value="" aria-label="Part">
            <RadioGroupItem value="a" label="part radio" />
          </RadioGroup>
        </div>
      ));
      const get = (name: string) => screen.getByLabelText(name) as HTMLInputElement;
      for (const [bare, part] of [
        ["bare box", "part box"],
        ["bare ticked", "part ticked"],
        ["bare disabled", "part disabled"],
        ["bare radio", "part radio"],
      ] as const) {
        // A ticked box is the browser's: the rule sets nothing on it, and the
        // part's edge transition has no edge to fade, so its transition is not
        // compared.
        const ticked = part === "part ticked";
        const read = (name: string) => {
          const all = ruled(get(name));
          return { ...all, transition: ticked ? "" : all.transition };
        };
        expect({ part, ...read(part) }).toEqual({ part, ...read(bare) });
      }
    });

    it(`hold the label and the description at 4.5:1 on the page and a card, ${theme}`, async () => {
      await page.viewport(600, 600);
      document.documentElement.dataset.theme = theme;
      const row = () => (
        <Checkbox
          box="native"
          size="sm"
          align="start"
          checked={false}
          label="I confirm each guest agreed to get emails about this wedding."
          description="They can stop them at any time."
        />
      );
      render(() => (
        <div class="bg-bg flex flex-col gap-4 p-4">
          <div data-ground="page">{row()}</div>
          <div data-ground="card" class="bg-surface p-4">
            {row()}
          </div>
        </div>
      ));
      for (const ground of ["page", "card"]) {
        const at = document.querySelector<HTMLElement>(`[data-ground="${ground}"]`)!;
        // The label's words and the description: the inks the part sets. A
        // note takes its caller's own ink, so it is not measured here.
        const words = [...at.querySelectorAll<HTMLElement>("label span")].filter(
          (el) => el.childElementCount === 0 && el.textContent!.trim().length > 0,
        );
        expect(words.length).toBeGreaterThanOrEqual(2);
        for (const el of words) {
          expect({ ground, text: el.textContent, ok: inkRatio(el) >= 4.5 }).toEqual({
            ground,
            text: el.textContent,
            ok: true,
          });
        }
      }
    });
  }
});
