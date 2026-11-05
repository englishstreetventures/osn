/**
 * `SkeletonOutline`, painted in Chromium against cire's two ramps.
 *
 * The unit tests read which text becomes a run; these read what the outline
 * paints and what it leaves alone. Each case is one way it can stop being the
 * placeholder the owner chose (englishstreetventures/osn#1955, Q6 C and Q7 C):
 * a run of text that is not one bar per line, at the ink's 10% and a 4px
 * corner; a boxed control that is not one block; a glyph drawn as itself; a
 * frame, hairline or ground the outline repaints; a placeholder that is not the
 * loaded markup's size; something inside a host can reach; or a pulse off the
 * loaders' timing. The classes are arbitrary Tailwind values, and a typo in one
 * emits no CSS while every class-name assertion still passes.
 */

import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import SkeletonOutline from "../src/skeleton-outline";
import { composite } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

/** A row as a host view draws one: a framed table, a status disc, a pill, a sort head, a legend. */
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
      <p data-part="wrapped" class="text-ui-base w-48">
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
      for (const name of ["pill", "switch", "input", "disc", "glyph"]) {
        expect([name, fillsWithInk(ground, part(name))]).toEqual([name, true]);
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
      for (const name of ["row", "frame", "head", "cell", "wrapped", "pill", "disc"]) {
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

  it("pulses its bars, blocks and glyphs on the loaders' timing, and holds the frame still", () => {
    const { part, outline } = drawn();
    for (const el of [runIn(part("cell")), part("pill"), part("glyph")]) {
      const s = style(el);
      expect([
        s.animationName,
        s.animationDuration,
        s.animationIterationCount,
        s.animationTimingFunction,
      ]).toEqual(["pulse", "2s", "infinite", "cubic-bezier(0.65, 0, 0.35, 1)"]);
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
