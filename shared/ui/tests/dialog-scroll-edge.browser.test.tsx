/**
 * A `Dialog` whose body is taller than the panel, in real Chromium.
 *
 * The panel is capped at 85% of the window at every width and scrolls. Its
 * `DialogHeader` stays at the top of the panel while the body scrolls under
 * it, with no line under it; a 16px fade from the panel's surface to clear
 * comes in under it over the first 16px of scroll, on a scroll timeline the
 * panel names. Nothing is drawn under the header at rest, or in a dialog
 * whose body fits. The fade takes no pointer, and the panel's scroll padding
 * follows the header's height, so focus never parks a field or its ring
 * under the header or the fade. Under reduced motion the fade does not ramp:
 * it is off at rest and fully on from the first pixel scrolled. A browser that
 * cannot read a scroll timeline keeps the hairline and draws no fade, which
 * Chromium cannot be made to show, so the stylesheet's `@supports` rules are
 * read instead.
 *
 * Every number here is layout, computed style or hit testing, which a DOM shim
 * cannot see. The shots go under the gitignored `__screenshots__/`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, For } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../src/ui/dialog";
import { Input } from "../src/ui/input";
import { Label } from "../src/ui/label";
import { emulateMedia, frames } from "./test-support/motion";

import "./test-support/tailwind.css";

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  cleanup();
  document.documentElement.style.removeProperty("--ui-surface");
});

const shot = (name: string) => `__screenshots__/dialog-scroll-edge.browser.test.tsx/${name}.png`;

/** The fade's height, and the scroll over which it comes in. */
const FADE = 16;
/** What the shared focus ring adds above a control: `--ui-focus-width` plus `--ui-focus-offset`. */
const RING = 4;

interface Opened {
  panel: HTMLElement;
  header: HTMLElement;
}

/**
 * A dialog with `fields` labelled fields in a 16px-padded body and a footer,
 * open and with its entry run finished. Only the entry and the scrim's runs are
 * finished: the fade's run follows the scroll, and finishing it would hold it
 * at full opacity.
 */
async function open(options: {
  presentation?: "centred" | "sheet";
  fields: number;
  title?: () => string;
}): Promise<Opened> {
  render(() => (
    <Dialog defaultOpen>
      <DialogContent presentation={options.presentation}>
        <DialogHeader>
          <DialogTitle>{options.title?.() ?? "Edit organisation"}</DialogTitle>
        </DialogHeader>
        <div class="flex flex-col gap-4 p-4">
          <For each={Array.from({ length: options.fields }, (_, i) => i + 1)}>
            {(n) => (
              <div class="flex flex-col gap-1">
                <Label for={`field-${n}`}>Field {n}</Label>
                <Input id={`field-${n}`} />
              </div>
            )}
          </For>
        </div>
        <DialogFooter>
          <button type="button">Done</button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  ));
  const panel = await vi.waitFor(() => screen.getByRole("dialog"));
  for (const run of document.getAnimations()) {
    if (run.timeline instanceof DocumentTimeline) run.finish();
  }
  await frames(2);
  const header = screen.getByRole("heading").closest<HTMLElement>("div")!;
  return { panel, header };
}

/** The fade's opacity, as the `::after` under the header computes it now. */
const fade = (header: HTMLElement) => Number(getComputedStyle(header, "::after").opacity);

async function scrollTo(panel: HTMLElement, top: number) {
  panel.scrollTop = top;
  await frames(2);
}

const end = (panel: HTMLElement) => panel.scrollHeight - panel.clientHeight;

/** Where the header's top sits, from the inside of the panel's top edge. */
function headerOffset({ panel, header }: Opened): number {
  const edge = panel.getBoundingClientRect().top + panel.clientTop;
  return header.getBoundingClientRect().top - edge;
}

describe("a sheet taller than 85% of a 390px phone", () => {
  it("keeps the header at the top of the sheet as the body scrolls", async () => {
    await page.viewport(390, 844);
    const opened = await open({ presentation: "sheet", fields: 24 });
    expect(end(opened.panel)).toBeGreaterThan(200);
    for (const top of [end(opened.panel) / 2, end(opened.panel)]) {
      await scrollTo(opened.panel, top);
      expect(Math.abs(headerOffset(opened))).toBeLessThanOrEqual(0.5);
    }
    await page.screenshot({ path: shot("sheet-390-end") });
  });

  it("draws no fade at rest", async () => {
    await page.viewport(390, 844);
    const { panel, header } = await open({ presentation: "sheet", fields: 24 });
    expect(panel.scrollTop).toBe(0);
    expect(fade(header)).toBe(0);
    await page.screenshot({ path: shot("sheet-390-rest") });
  });

  it("brings the fade in over the first 16px and holds it to the end", async () => {
    await page.viewport(390, 844);
    const { panel, header } = await open({ presentation: "sheet", fields: 24 });
    await scrollTo(panel, FADE / 2);
    expect(fade(header)).toBeGreaterThan(0.25);
    expect(fade(header)).toBeLessThan(0.75);
    for (const top of [FADE, end(panel) / 2, end(panel)]) {
      await scrollTo(panel, top);
      expect(fade(header)).toBe(1);
    }
    // Drawn, not only opaque: a 16px gradient band hung from the header's
    // inner bottom edge, over the body, taking no pointer.
    const band = getComputedStyle(header, "::after");
    expect(band.position).toBe("absolute");
    expect(band.height).toBe(`${FADE}px`);
    expect(band.backgroundImage).toMatch(/^linear-gradient\(/);
    expect(band.pointerEvents).toBe("none");
    const inner =
      header.getBoundingClientRect().height -
      Number.parseFloat(getComputedStyle(header).borderBottomWidth);
    expect(Number.parseFloat(band.top)).toBeCloseTo(inner, 1);
    await scrollTo(panel, end(panel) / 2);
    await page.screenshot({ path: shot("sheet-390-middle") });
  });

  it("draws no line under the header where the scroll timeline is read", async () => {
    await page.viewport(390, 844);
    const { header } = await open({ presentation: "sheet", fields: 24 });
    expect(CSS.supports("animation-timeline: scroll()")).toBe(true);
    const style = getComputedStyle(header);
    // The edge keeps its 1px, so the header is as tall as it is with the line.
    expect(style.borderBottomWidth).toBe("1px");
    expect(style.borderBottomColor).toBe("rgba(0, 0, 0, 0)");
  });

  it("paints the fade from the panel's own surface to clear, in light and dark", async () => {
    await page.viewport(390, 844);
    for (const surface of [undefined, "#242424"]) {
      if (surface) document.documentElement.style.setProperty("--ui-surface", surface);
      const { panel, header } = await open({ presentation: "sheet", fields: 24 });
      await scrollTo(panel, end(panel) / 2);
      const image = getComputedStyle(header, "::after").backgroundImage;
      const background = getComputedStyle(panel).backgroundColor;
      expect(image).toBe(`linear-gradient(${background}, rgba(0, 0, 0, 0))`);
      expect(getComputedStyle(header).backgroundColor).toBe(background);
      await page.screenshot({ path: shot(`sheet-390-middle-${surface ? "dark" : "light"}`) });
      cleanup();
    }
  });

  it("lets a press inside the fade reach the field under it", async () => {
    await page.viewport(390, 844);
    const { panel, header } = await open({ presentation: "sheet", fields: 24 });
    await scrollTo(panel, end(panel) / 2);
    const box = header.getBoundingClientRect();
    const hit = document.elementFromPoint(box.left + box.width / 2, box.bottom + FADE / 2);
    expect(hit).not.toBeNull();
    expect(header.contains(hit)).toBe(false);
    expect(panel.contains(hit)).toBe(true);
  });

  it("brings a field focused backwards out from under the header and the fade", async () => {
    await page.viewport(390, 844);
    const { panel, header } = await open({ presentation: "sheet", fields: 24 });
    const field = document.getElementById("field-6")!;
    // Scroll until field 6 sits partly under the header, then Shift+Tab to it from field 7.
    const under =
      field.getBoundingClientRect().top -
      header.getBoundingClientRect().bottom +
      field.getBoundingClientRect().height / 2;
    await scrollTo(panel, panel.scrollTop + under);
    expect(field.getBoundingClientRect().top).toBeLessThan(header.getBoundingClientRect().bottom);
    document.getElementById("field-7")!.focus({ preventScroll: true });
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(field);
    await frames(2);
    expect(field.getBoundingClientRect().top - RING).toBeGreaterThanOrEqual(
      header.getBoundingClientRect().bottom + FADE - 0.5,
    );
    await page.screenshot({ path: shot("sheet-390-focus-back") });
  });

  it("follows a title that wraps with the scroll padding", async () => {
    await page.viewport(390, 844);
    const [title, setTitle] = createSignal("Edit organisation");
    const { panel, header } = await open({ presentation: "sheet", fields: 24, title });
    const padding = () => Number.parseFloat(getComputedStyle(panel).scrollPaddingTop);
    const one = header.getBoundingClientRect().height;
    expect(padding()).toBeCloseTo(one + FADE + RING, 0);
    setTitle("A title long enough to wrap onto a second and a third line at 390px wide");
    await vi.waitFor(() => expect(header.getBoundingClientRect().height).toBeGreaterThan(one + 10));
    await vi.waitFor(() =>
      expect(padding()).toBeCloseTo(header.getBoundingClientRect().height + FADE + RING, 0),
    );
  });
});

describe("a dialog whose body fits", () => {
  // The scroll Kobalte's focus-trap `span`s would add is a single pixel, so
  // the fade is read after a try at scrolling, under reduced motion too, where
  // that pixel would bring it in whole.
  it.each(["no-preference", "reduce"] as const)(
    "draws no fade and no line, and does not scroll (motion: %s)",
    async (reducedMotion) => {
      await emulateMedia({ reducedMotion });
      await page.viewport(390, 844);
      const { panel, header } = await open({ presentation: "sheet", fields: 2 });
      expect(panel.querySelectorAll(":scope > [data-focus-trap]")).toHaveLength(2);
      expect(end(panel)).toBeLessThanOrEqual(0);
      await scrollTo(panel, 40);
      expect(panel.scrollTop).toBe(0);
      expect(fade(header)).toBe(0);
      expect(getComputedStyle(header).borderBottomColor).toBe("rgba(0, 0, 0, 0)");
      await page.screenshot({ path: shot(`sheet-390-fits-${reducedMotion}`) });
    },
  );
});

describe("a card taller than 85% of a 1440×900 window", () => {
  it("is capped at 85% of the window and scrolls under a header that stays", async () => {
    await page.viewport(1440, 900);
    const opened = await open({ presentation: "sheet", fields: 24 });
    const { panel, header } = opened;
    expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(900 * 0.85 + 0.5);
    expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(end(panel)).toBeGreaterThan(0);
    await scrollTo(panel, end(panel) / 2);
    expect(Math.abs(headerOffset(opened))).toBeLessThanOrEqual(0.5);
    expect(fade(header)).toBe(1);
    await page.screenshot({ path: shot("card-1440-middle") });
  });

  // `centred` is the card at every width, so a phone caps it too: today a
  // centred card taller than the window is cut off there as on a desktop.
  it.each([
    [1440, 900],
    [390, 844],
  ])("caps a centred card the same way at %ipx", async (width, height) => {
    await page.viewport(width, height);
    const { panel, header } = await open({ presentation: "centred", fields: 24 });
    expect(panel.getBoundingClientRect().height).toBeLessThanOrEqual(height * 0.85 + 0.5);
    expect(panel.getBoundingClientRect().top).toBeGreaterThanOrEqual(0);
    expect(end(panel)).toBeGreaterThan(0);
    await scrollTo(panel, end(panel));
    expect(fade(header)).toBe(1);
    await page.screenshot({ path: shot(`centred-${width}-end`) });
  });
});

describe("under reduced motion", () => {
  it("shows the fade whole from the first pixel scrolled, and never part-way", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    await page.viewport(390, 844);
    const { panel, header } = await open({ presentation: "sheet", fields: 24 });
    expect(fade(header)).toBe(0);
    for (const top of [1, FADE / 4, FADE / 2, FADE, end(panel)]) {
      await scrollTo(panel, top);
      expect(fade(header)).toBe(1);
    }
    await scrollTo(panel, 0);
    expect(fade(header)).toBe(0);
  });
});

describe("where a browser cannot read a scroll timeline", () => {
  /** Every style rule in the page whose selector names `className`, with the rules it sits in. */
  function rulesFor(className: string): { rule: CSSStyleRule; within: CSSRule[] }[] {
    const escaped = CSS.escape(className);
    const found: { rule: CSSStyleRule; within: CSSRule[] }[] = [];
    const walk = (rules: CSSRuleList, within: CSSRule[]) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule && rule.selectorText.includes(`.${escaped}`)) {
          found.push({ rule, within });
        }
        if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules, [...within, rule]);
      }
    };
    for (const sheet of document.styleSheets) walk(sheet.cssRules, []);
    return found;
  }

  it("keeps the hairline and draws no fade: both changes sit behind @supports", async () => {
    await page.viewport(390, 844);
    const { header } = await open({ presentation: "sheet", fields: 24 });
    const gated = [...header.classList].filter((c) =>
      /border-b-transparent|scroll-edge-fade/.test(c),
    );
    expect(gated).toHaveLength(2);
    for (const className of gated) {
      const rules = rulesFor(className);
      expect(rules.length).toBeGreaterThan(0);
      for (const { within } of rules) {
        expect(
          within.some(
            (r) =>
              r instanceof CSSSupportsRule &&
              /animation-timeline:\s*scroll\(\)/.test(r.conditionText),
          ),
        ).toBe(true);
      }
    }
    // Outside the query the header keeps its hairline.
    expect(header.classList.contains("base:border-ui-hairline")).toBe(true);
  });
});
