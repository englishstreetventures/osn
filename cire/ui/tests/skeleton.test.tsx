import "@testing-library/jest-dom/vitest";
// @vitest-environment happy-dom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";

import { PULSE } from "../src/lib/pulse";
import Skeleton, { type SkeletonStandIn } from "../src/skeleton";

/**
 * A skeleton is a block with no words: what it can get wrong is its corner,
 * its fill, its pulse, and what a screen reader makes of it. The corner and
 * the fill per shape are the owner's choice (englishstreetventures/osn#1837:
 * the blocks at full surface, the toolbar pieces at 60%), so these read the
 * classes by name — a different class is a different design. Whether the
 * classes paint what they say is `skeleton.browser.test.tsx`.
 */

afterEach(cleanup);

const EVERY_STAND_IN = Object.keys({
  card: true,
  row: true,
  field: true,
  pill: true,
} satisfies Record<SkeletonStandIn, true>) as SkeletonStandIn[];

function block(standsFor?: SkeletonStandIn, cls?: string): HTMLElement {
  const { container } = render(() => <Skeleton standsFor={standsFor} class={cls} />);
  return container.firstElementChild as HTMLElement;
}

function classes(el: Element): string[] {
  return el.className.split(/\s+/).filter(Boolean);
}

const corners = (el: Element) => classes(el).filter((c) => c.includes("rounded-"));
const fills = (el: Element) => classes(el).filter((c) => c.includes("bg-"));

describe("Skeleton", () => {
  it("takes the corner of what each shape stands in for", () => {
    expect(EVERY_STAND_IN.map((standsFor) => [standsFor, corners(block(standsFor))])).toEqual([
      ["card", ["base:rounded-ui-lg"]],
      ["row", ["base:rounded-ui-sm"]],
      ["field", ["base:rounded-ui-field"]],
      ["pill", ["base:rounded-ui-pill"]],
    ]);
  });

  it("fills the blocks at the full surface and the toolbar pieces at 60%", () => {
    expect(EVERY_STAND_IN.map((standsFor) => [standsFor, fills(block(standsFor))])).toEqual([
      ["card", ["base:bg-ui-surface"]],
      ["row", ["base:bg-ui-surface"]],
      ["field", ["base:bg-ui-surface/60"]],
      ["pill", ["base:bg-ui-surface/60"]],
    ]);
  });

  it("draws a card when no shape is asked for", () => {
    expect(block().className).toBe(block("card").className);
  });

  it("draws a card for a shape it does not have, however it was typed", () => {
    // A shape read from stored data and cast to the type must not paint a
    // block with no corner and no fill.
    for (const unknown of ["circle", "", "constructor", "__proto__"]) {
      expect(block(unknown as SkeletonStandIn).className).toBe(block("card").className);
    }
  });

  it("is hidden from a screen reader and has no role of its own", () => {
    // It stands for nothing a screen reader should read; the region around it
    // carries `aria-busy`.
    for (const standsFor of EVERY_STAND_IN) {
      const el = block(standsFor);
      expect(el.tagName).toBe("DIV");
      expect(el).toHaveAttribute("aria-hidden", "true");
      expect(el).not.toHaveAttribute("role");
      expect(el.childNodes).toHaveLength(0);
    }
  });

  it("pulses on the shared pulse, at every shape", () => {
    for (const standsFor of EVERY_STAND_IN) {
      expect(block(standsFor).className).toContain(PULSE);
    }
  });

  it("puts the caller's size and place after its own classes", () => {
    const el = block("field", "h-7 w-64 max-w-full min-w-0");
    expect(el.className).toBe(
      `${PULSE} base:bg-ui-surface/60 base:rounded-ui-field h-7 w-64 max-w-full min-w-0`,
    );
    expect(block("card").className).toBe(`${PULSE} base:bg-ui-surface base:rounded-ui-lg`);
  });
});

describe("PULSE", () => {
  it("runs Tailwind's pulse for 2s on the app's motion scale and in-out curve", () => {
    // The owner's motion rule: every timing reads the motion tokens, so the
    // pulse slows with `--motion-scale` like the attention glow, and falls
    // back to the contract's curve where an app declares none.
    expect(PULSE).toBe(
      "base:animate-[pulse_calc(2s*var(--motion-scale,1))_var(--ease-in-out,var(--ui-ease-in-out))_infinite]",
    );
  });
});
