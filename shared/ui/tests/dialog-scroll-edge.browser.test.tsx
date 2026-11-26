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
 * under the header or the fade. Under reduced motion the fade ramps the same
 * way, the owner's choice on #2391: it moves nothing, and its opacity follows
 * only the reader's scroll, never time. A browser that
 * cannot read a scroll timeline keeps the hairline and draws no fade, which
 * Chromium cannot be made to show, so the stylesheet's `@supports` rules are
 * read instead.
 *
 * Every number here is layout, computed style or hit testing, which a DOM shim
 * cannot see. The shots go under the gitignored `__screenshots__/`.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import { createSignal, For } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../src/ui/dialog";
import { Input } from "../src/ui/input";
import { Label } from "../src/ui/label";
import { emulateMedia, frames } from "./test-support/motion";

import "./test-support/tailwind.css";

const shot = (name: string) => `__screenshots__/dialog-scroll-edge.browser.test.tsx/${name}.png`;

/** The fade's height, and the scroll over which it comes in. */
const FADE = 16;
/** What the panel's scroll padding allows above a control for its label and a focus mark (`DIALOG_SCROLL_PADDING`). */
const LABEL = 24;

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

/**
 * How far the focus mark of `element` reaches above its box: its outline's
 * width and offset, or the widest spread among its box shadows, a ring and its
 * offset drawn as two.
 */
function focusReach(element: Element): number {
  const style = getComputedStyle(element);
  const outline =
    style.outlineStyle === "none"
      ? 0
      : Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
  const spreads = [
    ...style.boxShadow.matchAll(/(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px/g),
  ].map((m) => Number.parseFloat(m[4]!));
  return Math.max(outline, 0, ...spreads);
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

  // The second pass maps only `--ui-surface` to a dark grey: a stand-in for a
  // dark theme's sheet colour, not a dark theme (its labels stay dark).
  it("paints the fade from the panel's own surface to clear, under the test palette and a dark surface", async () => {
    await page.viewport(390, 844);
    for (const surface of [undefined, "#242424"]) {
      if (surface) document.documentElement.style.setProperty("--ui-surface", surface);
      const { panel, header } = await open({ presentation: "sheet", fields: 24 });
      await scrollTo(panel, end(panel) / 2);
      const image = getComputedStyle(header, "::after").backgroundImage;
      const background = getComputedStyle(panel).backgroundColor;
      expect(image).toBe(`linear-gradient(${background}, rgba(0, 0, 0, 0))`);
      expect(getComputedStyle(header).backgroundColor).toBe(background);
      await page.screenshot({
        path: shot(`sheet-390-middle-${surface ? "dark-surface" : "palette"}`),
      });
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

  // Two places Shift+Tab can find a field: half under the header, where it
  // would park under the header with no padding, and its top just under the
  // fade's, where a padding with no room for the label would park the label
  // under the fade.
  it.each([
    [
      "half under the header",
      (field: DOMRect, header: DOMRect) => field.top - header.bottom + field.height / 2,
    ],
    [
      "just under the fade's top",
      (field: DOMRect, header: DOMRect) => field.top - header.bottom - FADE / 4,
    ],
  ] as const)(
    "brings a field focused backwards from %s, and its label, out from under the header and the fade",
    async (where, offset) => {
      await page.viewport(390, 844);
      const { panel, header } = await open({ presentation: "sheet", fields: 24 });
      const field = document.getElementById("field-6")!;
      // Scroll field 6 to where it starts, then Shift+Tab to it from field 7.
      await scrollTo(
        panel,
        panel.scrollTop + offset(field.getBoundingClientRect(), header.getBoundingClientRect()),
      );
      expect(field.getBoundingClientRect().top).toBeLessThan(
        header.getBoundingClientRect().bottom + FADE,
      );
      document.getElementById("field-7")!.focus({ preventScroll: true });
      await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
      expect(document.activeElement).toBe(field);
      await frames(2);
      // The field's own ring, read from the page: a wider ring than the padding
      // allows for would park its top under the fade.
      const reach = focusReach(field);
      expect(reach).toBeGreaterThan(0);
      const clear = header.getBoundingClientRect().bottom + FADE - 0.5;
      expect(field.getBoundingClientRect().top - reach).toBeGreaterThanOrEqual(clear);
      // And the field's label, which names it, clear of the fade too.
      const label = document.querySelector(`label[for="${field.id}"]`)!;
      expect(label.getBoundingClientRect().top).toBeGreaterThanOrEqual(clear);
      await page.screenshot({ path: shot(`sheet-390-focus-back-${where.split(" ").join("-")}`) });
    },
  );

  it("follows a title that wraps with the scroll padding", async () => {
    await page.viewport(390, 844);
    const [title, setTitle] = createSignal("Edit organisation");
    const { panel, header } = await open({ presentation: "sheet", fields: 24, title });
    const padding = () => Number.parseFloat(getComputedStyle(panel).scrollPaddingTop);
    const one = header.getBoundingClientRect().height;
    expect(padding()).toBeCloseTo(one + FADE + LABEL, 0);
    setTitle("A title long enough to wrap onto a second and a third line at 390px wide");
    await vi.waitFor(() => expect(header.getBoundingClientRect().height).toBeGreaterThan(one + 10));
    await vi.waitFor(() =>
      expect(padding()).toBeCloseTo(header.getBoundingClientRect().height + FADE + LABEL, 0),
    );
  });
});

describe("a sheet past its cap, at the start of the focus trap", () => {
  /** Whether `control` sits inside the panel's box, below the scroll padding's clear line. */
  function inView(panel: HTMLElement, control: Element): boolean {
    const box = panel.getBoundingClientRect();
    const top = box.top + panel.clientTop;
    const clear = top + Number.parseFloat(getComputedStyle(panel).scrollPaddingTop);
    const rect = control.getBoundingClientRect();
    return rect.top >= clear - 0.5 && rect.bottom <= top + panel.clientHeight + 0.5;
  }

  it("brings the footer's action into view when Shift+Tab wraps onto it", async () => {
    await page.viewport(390, 844);
    const { panel } = await open({ presentation: "sheet", fields: 24 });
    const done = screen.getByRole("button", { name: "Done" });
    expect(inView(panel, done)).toBe(false);
    document.getElementById("field-1")!.focus();
    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    expect(document.activeElement).toBe(done);
    await frames(2);
    expect(inView(panel, done)).toBe(true);
    await page.screenshot({ path: shot("sheet-390-wrap-back") });
  });
});

describe("a title too long for the panel", () => {
  // A name another person chose can run to a thousand characters. Stuck, a
  // title row taller than the panel would cover the dialog's words and its
  // buttons for good; past a third of the panel it scrolls away instead.
  it("stops sticking, so the body and the footer can still be scrolled to", async () => {
    await page.viewport(390, 844);
    const long = () => `Remove ${"Someone With A Very Long Name ".repeat(40)}?`;
    const { panel, header } = await open({ presentation: "sheet", fields: 2, title: long });
    await vi.waitFor(() =>
      expect(header.getBoundingClientRect().height).toBeGreaterThan(panel.clientHeight / 3),
    );
    await vi.waitFor(() => expect(getComputedStyle(header).position).toBe("static"));
    expect(getComputedStyle(panel).getPropertyValue("--ui-dialog-header-height").trim()).toBe(
      "0px",
    );
    await scrollTo(panel, end(panel));
    const done = screen.getByRole("button", { name: "Done" });
    const box = done.getBoundingClientRect();
    expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(
      done,
    );
    await page.screenshot({ path: shot("sheet-390-long-title-end") });
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
  // The owner's choice on #2391 (2026-11-18): "Ramp, same as normal". The
  // fade's opacity follows the reader's own scroll over the same 16px, and
  // nothing about it moves or runs on time.
  it("ramps the fade with the scroll, as with motion on, and moves nothing by itself", async () => {
    await emulateMedia({ reducedMotion: "reduce" });
    await page.viewport(390, 844);
    const { panel, header } = await open({ presentation: "sheet", fields: 24 });
    expect(fade(header)).toBe(0);
    await scrollTo(panel, FADE / 4);
    expect(fade(header)).toBeGreaterThan(0.1);
    expect(fade(header)).toBeLessThan(0.4);
    await scrollTo(panel, FADE / 2);
    expect(fade(header)).toBeGreaterThan(0.35);
    expect(fade(header)).toBeLessThan(0.65);
    for (const top of [FADE, end(panel)]) {
      await scrollTo(panel, top);
      expect(fade(header)).toBe(1);
    }
    // No movement: the band has no transform, and every run on it follows the
    // panel's scroll, none the clock.
    expect(getComputedStyle(header, "::after").transform).toBe("none");
    const runs = document
      .getAnimations()
      .filter((run) => (run.effect as KeyframeEffect | null)?.target === header);
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) {
      expect(run.timeline).toBeInstanceOf(ScrollTimeline);
      expect((run.effect as KeyframeEffect).pseudoElement).toBe("::after");
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
