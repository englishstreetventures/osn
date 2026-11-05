/**
 * `SkeletonOutline`, painted in Chromium against cire's two ramps.
 *
 * The unit tests read which text becomes a run; these read what the outline
 * paints and what it leaves alone. Each case is one way it can stop being the
 * placeholder the owner chose (englishstreetventures/osn#1955, Q6 C and Q7 C):
 * a run of text that is not one bar per line, at the ink's 10% and a 4px
 * corner; a boxed control that is not one block; a glyph drawn as itself; a
 * picture that paints its pixels; a frame, hairline or ground the outline
 * repaints; a placeholder that is not the loaded markup's size; something
 * inside a host can reach; or a pulse off `Skeleton`'s. The classes are arbitrary Tailwind values, and a typo in one
 * emits no CSS while every class-name assertion still passes.
 */

import { Meter } from "@shared/ui/ui/meter";
import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import { CardCtaButton } from "../src/card";
import Skeleton from "../src/skeleton";
import SkeletonOutline from "../src/skeleton-outline";
import { composite } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

/** A picture of one red square, loaded from no host. */
const RED_SQUARE =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='8' height='8'%3E%3Crect width='8' height='8' fill='%23f00'/%3E%3C/svg%3E";

/** A row as a host view draws one: a framed table, a status disc, a pill, a sort head, a legend, a picture. */
function Row() {
  return (
    <div class="flex flex-col gap-4" data-part="row">
      <dl class="text-ui-sm flex flex-wrap gap-x-4">
        <div class="flex gap-1.5">
          <dt class="uppercase">Attending</dt>
          <dd>64</dd>
        </div>
      </dl>
      <table
        data-part="frame"
        class="border-ui-hairline rounded-ui-sm w-full border-separate border-spacing-0 border"
      >
        <thead>
          <tr>
            <th data-part="head" class="bg-ui-ground border-ui-hairline border-b px-4 text-left">
              <button type="button" data-skeleton="text" data-part="sort" class="inline-flex gap-1">
                Guest
                <svg data-part="glyph" viewBox="0 0 10 10" class="size-3" aria-hidden="true">
                  <path d="M1 3l4 4 4-4" stroke="currentColor" fill="none" />
                </svg>
              </button>
            </th>
            <th class="bg-ui-ground border-ui-hairline border-b px-4 text-left">Status</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td data-part="cell" class="border-ui-hairline/40 border-b px-4 py-3">
              Chiamaka Okonkwo
              <a href="#guest" data-part="link" class="block underline">
                +1 · Hamish
              </a>
            </td>
            <td class="border-ui-hairline/40 border-b px-4 py-3">
              <span class="inline-flex items-center gap-1.5">
                <span
                  data-skeleton="block"
                  data-part="disc"
                  class="bg-ui-accent inline-flex size-4 rounded-full"
                />
                <span>Attending</span>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="flex gap-2">
        <button
          type="button"
          data-part="pill"
          class="border-ui-accent bg-ui-surface from-ui-accent to-ui-surface rounded-ui-control border bg-linear-to-b px-3 py-1 shadow"
        >
          <svg viewBox="0 0 10 10" class="size-3" aria-hidden="true">
            <path d="M1 1h8v8H1z" />
          </svg>
          Edit
        </button>
        <button
          type="button"
          role="switch"
          aria-checked="true"
          aria-label="Plus-one"
          data-part="switch"
          class="bg-ui-accent h-5 w-9 rounded-full"
        />
        <input
          data-part="input"
          aria-label="Search"
          placeholder="Search guests"
          class="border-ui-hairline border"
        />
      </div>
      <div data-part="meter" class="w-40">
        <Meter value={64} max={120} label="Replies" />
      </div>
      <img
        data-part="picture"
        alt=""
        src={RED_SQUARE}
        class="rounded-ui-field size-10 object-cover"
      />
      <div data-part="cta">
        <CardCtaButton onClick={() => {}}>See replies per event</CardCtaButton>
      </div>
      {/* A switch as `@shared/ui` draws one: a hidden input, then the track. */}
      <label class="inline-flex items-center gap-2">
        <input type="checkbox" role="switch" aria-checked="true" class="sr-only" checked />
        <span data-part="track" class="bg-ui-accent inline-flex h-5 w-9 rounded-full p-0.5">
          <span class="bg-ui-on-accent size-3.5 rounded-full" />
        </span>
        <span class="sr-only">Plus-one</span>
      </label>
      <p data-part="wrapped" class="text-ui-base w-48 text-shadow-sm">
        Saving without changing these keeps the dietary requirements already given.
      </p>
    </div>
  );
}

function Ground(props: { ramp: Ramp; children: JSX.Element; width?: number }) {
  return (
    <div
      data-ramp={props.ramp === "light" ? "light" : undefined}
      class="bg-ui-ground text-ui-ink p-4"
      style={{ width: `${props.width ?? 520}px` }}
    >
      {props.children}
    </div>
  );
}

function drawn(ramp: Ramp = "dark", width?: number) {
  const { container } = render(() => (
    <Ground ramp={ramp} width={width}>
      <SkeletonOutline>
        <Row />
      </SkeletonOutline>
    </Ground>
  ));
  const ground = container.firstElementChild as HTMLElement;
  const part = (name: string) => ground.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  return { ground, part, outline: ground.querySelector<HTMLElement>("[data-skeleton-outline]")! };
}

/** The same row, loaded: no outline. */
function loaded(ramp: Ramp = "dark", width?: number) {
  const { container } = render(() => (
    <Ground ramp={ramp} width={width}>
      <Row />
    </Ground>
  ));
  const ground = container.firstElementChild as HTMLElement;
  return (name: string) => ground.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
}

const style = (el: Element) => getComputedStyle(el);

function token(from: Element, name: string): string {
  return style(from).getPropertyValue(name).trim();
}

/** `color` at `alpha` laid over `under`, blended in sRGB as the screen does. */
function blend(under: string, color: string, alpha: number): [number, number, number] {
  const u = composite([under]);
  const c = composite([color]);
  return [0, 1, 2].map((i) => Math.round(alpha * c[i]! + (1 - alpha) * u[i]!)) as [
    number,
    number,
    number,
  ];
}

const near = (a: readonly number[], b: readonly number[]) =>
  a.every((value, i) => Math.abs(value - b[i]!) <= 1);

/** The ink at 10% over the ground, painted: what every bar, block and glyph fills with. */
function fillsWithInk(ground: HTMLElement, el: Element): boolean {
  const under = style(ground).backgroundColor;
  return near(
    composite([under, style(el).backgroundColor]),
    blend(under, token(el, "--ui-ink"), 0.1),
  );
}

const runIn = (el: Element) => el.querySelector<HTMLElement>("[data-skeleton-run]")!;

describe("SkeletonOutline", () => {
  for (const ramp of RAMPS) {
    it(`draws each run of text as a bar per line, at the ink's 10% and a 4px corner, ${ramp}`, () => {
      const { ground, part } = drawn(ramp);
      const run = runIn(part("wrapped"));
      const lines = new Set([...run.getClientRects()].map((r) => Math.round(r.top)));
      expect(lines.size).toBeGreaterThan(1);
      // `clone` gives every line its own two rounded ends; `slice` would round
      // the first line's start and the last line's end only.
      const decoration =
        style(run).boxDecorationBreak ||
        style(run).getPropertyValue("-webkit-box-decoration-break");
      expect([
        decoration,
        style(run).borderTopLeftRadius,
        style(run).borderBottomRightRadius,
        fillsWithInk(ground, run),
      ]).toEqual(["clone", "4px", "4px", true]);
    });

    it(`fills each boxed control, disc and glyph as one block at the ink's 10%, ${ramp}`, () => {
      const { ground, part } = drawn(ramp);
      for (const name of ["pill", "switch", "track", "input", "disc", "glyph", "picture"]) {
        expect([name, fillsWithInk(ground, part(name))]).toEqual([name, true]);
      }
      {
        const meter = part("meter").firstElementChild!;
        expect(["meter", fillsWithInk(ground, meter)]).toEqual(["meter", true]);
      }
      // Tailwind writes a cleared shadow as five transparent layers.
      const shadow = style(part("pill")).boxShadow;
      // A gradient on a control (the pill here) would paint over the block.
      expect([
        style(part("pill")).borderTopColor,
        style(part("pill")).backgroundImage,
        shadow === "none" ||
          shadow.split(/,(?![^(]*\))/).every((layer) => layer.includes("rgba(0, 0, 0, 0)")),
      ]).toEqual(["rgba(0, 0, 0, 0)", "none", true]);
      expect(style(part("glyph")).borderTopLeftRadius).toBe("4px");
    });
  }

  it("paints no letter, underline or placeholder", () => {
    const { part } = drawn();
    for (const el of [runIn(part("cell")), runIn(part("link")), part("input")]) {
      expect(style(el).webkitTextFillColor).toBe("rgba(0, 0, 0, 0)");
    }
    expect(style(part("link")).textDecorationColor).toBe("rgba(0, 0, 0, 0)");
    expect(style(part("wrapped")).textShadow).toBe("none");
    expect(getComputedStyle(part("input"), "::placeholder").color).toBe("rgba(0, 0, 0, 0)");
  });

  it("hides what a block holds, and draws a control marked as words as its words", () => {
    const { part } = drawn();
    const pill = part("pill");
    expect(
      [...pill.querySelectorAll("*")].every((child) => style(child).visibility === "hidden"),
    ).toBe(true);
    // The sort head is a button, marked `text`: a bar for its word, a glyph
    // block for its chevron, and no fill of its own.
    const sort = part("sort");
    expect(style(sort).backgroundColor).toBe("rgba(0, 0, 0, 0)");
    expect(style(runIn(sort)).visibility).toBe("visible");
    expect(style(part("glyph")).visibility).toBe("visible");
    expect([...part("glyph").children].every((path) => style(path).visibility === "hidden")).toBe(
      true,
    );
    // A switch's thumb is what its track holds.
    expect(style(part("track").firstElementChild!).visibility).toBe("hidden");
    // A meter's fill is what it holds: hidden, so the track reads as one block.
    expect(style(part("meter").firstElementChild!.firstElementChild!).visibility).toBe("hidden");
    // A card's call to action is words: a bar, no block.
    const cta = part("cta").querySelector("button")!;
    expect([style(cta).backgroundColor, style(runIn(cta)).visibility]).toEqual([
      "rgba(0, 0, 0, 0)",
      "visible",
    ]);
  });

  for (const ramp of RAMPS) {
    it(`leaves the frame, the hairlines and the head's ground as they are loaded, ${ramp}`, () => {
      const { part } = drawn(ramp);
      const before = loaded(ramp);
      for (const [name, property] of [
        ["frame", "border-top-color"],
        ["head", "border-bottom-color"],
        ["head", "background-color"],
        ["cell", "border-bottom-color"],
      ] as const) {
        expect([name, property, style(part(name)).getPropertyValue(property)]).toEqual([
          name,
          property,
          style(before(name)).getPropertyValue(property),
        ]);
      }
    });
  }

  for (const width of [520, 300]) {
    it(`takes the loaded markup's size, every part of it, at ${width}px`, () => {
      const { part } = drawn("dark", width);
      const before = loaded("dark", width);
      for (const name of ["row", "frame", "head", "cell", "wrapped", "pill", "disc", "picture"]) {
        const a = part(name).getBoundingClientRect();
        const b = before(name).getBoundingClientRect();
        expect([
          name,
          Math.abs(a.height - b.height) <= 0.5,
          Math.abs(a.width - b.width) <= 0.5,
        ]).toEqual([name, true, true]);
      }
    });
  }

  it("lets nothing inside be focused or pressed", () => {
    const { outline, part } = drawn();
    for (const control of outline.querySelectorAll<HTMLElement>("button, input, a[href]")) {
      control.focus();
      expect(document.activeElement).not.toBe(control);
    }
    const pill = part("pill").getBoundingClientRect();
    const hit = document.elementFromPoint(pill.left + pill.width / 2, pill.top + pill.height / 2);
    expect(hit === null || !part("pill").contains(hit)).toBe(true);
  });

  it("paints none of a picture's pixels, only the block's fill", async () => {
    const { part } = drawn();
    const before = loaded();
    /** How many of the element's pixels are the picture's red. */
    const reds = async (el: HTMLImageElement) => {
      await el.decode();
      const shot: unknown = await page.screenshot({ element: el, save: false, base64: true });
      const image = new Image();
      image.src = `data:image/png;base64,${typeof shot === "string" ? shot : (shot as { base64: string }).base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, image.width, image.height).data;
      let count = 0;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i]! - Math.max(data[i + 1]!, data[i + 2]!) > 100) count += 1;
      }
      return count;
    };
    const loadedReds = await reds(before("picture") as HTMLImageElement);
    expect([await reds(part("picture") as HTMLImageElement), loadedReds > 0]).toEqual([0, true]);
  });

  it("pulses its bars, blocks and glyphs as `Skeleton` does, and holds the frame still", () => {
    const { part, outline } = drawn();
    // `Skeleton` runs `lib/pulse.ts`'s class, whose values the outline writes
    // out again: compared here as the browser computes them, so an edit to
    // one that the other does not follow fails.
    const { container } = render(() => <Skeleton class="h-4 w-10" />);
    const pulse = (el: Element) => {
      const s = style(el);
      return [
        s.animationName,
        s.animationDuration,
        s.animationIterationCount,
        s.animationTimingFunction,
      ];
    };
    const skeleton = pulse(container.firstElementChild!);
    expect(skeleton[0]).toBe("pulse");
    for (const el of [runIn(part("cell")), part("pill"), part("glyph"), part("picture")]) {
      expect(pulse(el)).toEqual(skeleton);
    }
    for (const el of [outline, part("frame"), part("head")]) {
      expect(style(el).animationName).toBe("none");
    }
  });

  it("slows and speeds with the app's motion scale", () => {
    const { container } = render(() => (
      <div style={{ "--motion-scale": "0.5" }}>
        <SkeletonOutline>
          <p>Ceremony</p>
        </SkeletonOutline>
      </div>
    ));
    expect(style(runIn(container)).animationDuration).toBe("1s");
  });
});
