/**
 * `Skeleton`, painted in Chromium against cire's two ramps.
 *
 * The unit tests read the class names; these read what the classes paint.
 * Each case is one way the block can stop being the placeholder the owner
 * chose (englishstreetventures/osn#1837): the wrong corner for what it stands in for, the
 * wrong fill, or a pulse that does not run, runs at a fixed pace, or ignores
 * the app's curve. The pulse is an arbitrary Tailwind value, and a typo in one
 * emits no CSS at all while every class-name assertion still passes.
 */

import { cleanup, render } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import Skeleton, { type SkeletonStandIn } from "../src/skeleton";
import { composite } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

function Ramp(props: { ramp: Ramp; style?: JSX.CSSProperties; children: JSX.Element }) {
  return (
    <div
      data-ramp={props.ramp === "light" ? "light" : undefined}
      class="bg-ui-ground p-4"
      style={props.style}
    >
      {props.children}
    </div>
  );
}

function drawn(standsFor: SkeletonStandIn, ramp: Ramp = "dark", style?: JSX.CSSProperties) {
  const { container } = render(() => (
    <Ramp ramp={ramp} style={style}>
      <Skeleton standsFor={standsFor} class="h-7 w-40" />
    </Ramp>
  ));
  const wrap = container.firstElementChild as HTMLElement;
  return { wrap, block: wrap.firstElementChild as HTMLElement };
}

function token(from: Element, name: string): string {
  return getComputedStyle(from).getPropertyValue(name).trim();
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

function near(a: readonly number[], b: readonly number[]): boolean {
  return a.every((value, i) => Math.abs(value - b[i]!) <= 1);
}

const CORNER = { card: "16px", row: "6px", field: "14px", pill: "999px" } as const satisfies Record<
  SkeletonStandIn,
  string
>;

/** How much of the surface each shape paints over the ground. */
const FILL = { card: 1, row: 1, field: 0.6, pill: 0.6 } as const satisfies Record<
  SkeletonStandIn,
  number
>;

const STAND_INS = Object.keys(CORNER) as SkeletonStandIn[];

describe("Skeleton", () => {
  it("paints each shape's corner", () => {
    expect(
      STAND_INS.map((standsFor) => [
        standsFor,
        getComputedStyle(drawn(standsFor).block).borderTopLeftRadius,
      ]),
    ).toEqual(STAND_INS.map((standsFor) => [standsFor, CORNER[standsFor]]));
  });

  for (const ramp of RAMPS) {
    it(`fills the blocks with the surface and the toolbar pieces with 60% of it, ${ramp}`, () => {
      for (const standsFor of STAND_INS) {
        const { wrap, block } = drawn(standsFor, ramp);
        const ground = getComputedStyle(wrap).backgroundColor;
        const painted = composite([ground, getComputedStyle(block).backgroundColor]);
        expect([
          standsFor,
          near(painted, blend(ground, token(block, "--ui-surface"), FILL[standsFor])),
        ]).toEqual([standsFor, true]);
        cleanup();
      }
    });
  }

  it("draws no edge", () => {
    for (const standsFor of STAND_INS) {
      expect(getComputedStyle(drawn(standsFor).block).borderTopWidth).toBe("0px");
      cleanup();
    }
  });

  it("pulses for 2s, without end, on the app's in-out curve", () => {
    const style = getComputedStyle(drawn("card").block);
    expect([
      style.animationName,
      style.animationDuration,
      style.animationIterationCount,
      style.animationTimingFunction,
    ]).toEqual(["pulse", "2s", "infinite", "cubic-bezier(0.65, 0, 0.35, 1)"]);
  });

  it("slows and speeds with the app's motion scale", () => {
    // `--motion-scale` lets a reference behaviour be slowed and judged frame
    // by frame (cire/host/DESIGN.md §4 Motion); the pulse follows it like
    // every other timing.
    const style = getComputedStyle(drawn("pill", "dark", { "--motion-scale": "0.5" }).block);
    expect(style.animationDuration).toBe("1s");
  });

  it("eases on the app's own curve, not the contract's", () => {
    // Both tokens hold the house curve in every cire app, so the case above
    // cannot tell which one the pulse reads; here they differ.
    const style = getComputedStyle(
      drawn("row", "light", { "--ease-in-out": "linear", "--ui-ease-in-out": "ease-in" }).block,
    );
    expect(style.animationTimingFunction).toBe("linear");
  });
});
