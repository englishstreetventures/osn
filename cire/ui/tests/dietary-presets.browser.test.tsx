/**
 * The dietary pills' chosen look, motion and focus, measured in Chromium
 * against cire's two portal ramps and the marketing site's ground (the
 * 2026-11-04 consistency audit: the guest's diet chips take `choice`'s chosen
 * look, the house curve and the house focus outline).
 *
 * Each case is one way a guest would see a pill break: a ticked pill marked
 * by colour alone, or by an edge with no ring; a word under 4.5:1; a pill
 * under the pointer that looks ticked; a focus ring drawn flush to the edge
 * instead of the house outline, or one the scrolling track cuts off; a fade on
 * Tailwind's own curve; or a muted label drawn in full ink. The organiser's
 * trigger is checked at the portals' 34px.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import DietaryPresets from "../src/dietary-presets";
import DietaryPresetsPopover from "../src/dietary-presets-popover";
import { composite, painted, ratio } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));
const token = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();

/** The marketing site's ground and readable gold (`cire/landing/src/styles/global.css`). */
const LANDING = {
  "--ui-ground": "oklch(19.96% 0.0331 147.34)",
  "--ui-accent": "oklch(74.99% 0.0854 82.08)",
  "--ui-accent-ink": "oklch(74.99% 0.0854 82.08)",
} as JSX.CSSProperties;

function Ground(props: { ramp?: Ramp; style?: JSX.CSSProperties; children: JSX.Element }) {
  return (
    <div
      data-ramp={props.ramp === "light" ? "light" : undefined}
      class="bg-ui-ground w-80 p-4"
      style={props.style}
    >
      {props.children}
    </div>
  );
}

/** A pill: the label that holds the checkbox named `name`. */
function pill(name: string): HTMLElement {
  return screen.getByRole("checkbox", { name }).closest("label")!;
}

/** The ring a pill's `box-shadow` draws, as its spread in px, or 0. */
function ringSpread(el: Element): number {
  const shadow = getComputedStyle(el).boxShadow;
  if (shadow === "none") return 0;
  const rings = shadow.split(/,(?![^(]*\))/).map((s) => s.trim());
  const visible = rings.find((r) => !r.startsWith("rgba(0, 0, 0, 0)") && !/\/ 0\)/.test(r));
  const lengths = visible?.match(/-?\d+(\.\d+)?px/g) ?? [];
  return lengths.length ? Number.parseFloat(lengths.at(-1)!) : 0;
}

function onGround(el: Element, color: string): [number, number, number] {
  const ground = getComputedStyle(el.closest("[class*='bg-ui-ground']")!).backgroundColor;
  return composite([ground, color]);
}

describe("a ticked pill", () => {
  for (const [name, ramp, style] of [
    ["the portals' dark ramp", "dark", undefined],
    ["the portals' light ramp", "light", undefined],
    ["the marketing site", "dark", LANDING],
  ] as const) {
    it(`wears choice's chosen look, its word at 4.5:1, on ${name}`, async () => {
      render(() => (
        <Ground ramp={ramp} style={style}>
          <DietaryPresets value={["vegan"]} onChange={() => {}} wrap />
        </Ground>
      ));
      await settle();
      const chosen = pill("Vegan");
      const look = getComputedStyle(chosen);
      expect(painted(look.borderTopColor)).toBe(painted(token(chosen, "--ui-accent")));
      expect(ringSpread(chosen)).toBe(2);
      expect(painted(look.color)).toBe(painted(token(chosen, "--ui-accent-ink")));
      expect(
        ratio(onGround(chosen, look.color), onGround(chosen, "transparent")),
      ).toBeGreaterThanOrEqual(4.5);
      // No wash: a ticked pill is marked by its edge, ring and word.
      expect(look.backgroundColor).toBe("rgba(0, 0, 0, 0)");
    });
  }

  it("goes halfway under the pointer when unticked, with a 1px ring", async () => {
    render(() => (
      <Ground>
        <DietaryPresets value={["vegan"]} onChange={() => {}} wrap />
      </Ground>
    ));
    const idle = pill("Vegetarian");
    await userEvent.hover(idle);
    await settle();
    expect(ringSpread(idle)).toBe(1);
    const edge = painted(getComputedStyle(idle).borderTopColor);
    expect(edge).not.toBe(painted(token(idle, "--ui-hairline")));
    expect(edge).not.toBe(painted(token(idle, "--ui-accent")));
  });
});

describe("a pill's focus", () => {
  it("is the house outline, 2px at 2px, with no ring of its own", async () => {
    render(() => (
      <Ground>
        <button type="button">Before</button>
        <DietaryPresets value={[]} onChange={() => {}} wrap />
      </Ground>
    ));
    screen.getByRole("button", { name: "Before" }).focus();
    await userEvent.tab();
    const focused = document.activeElement!.closest("label")!;
    const style = getComputedStyle(focused);
    expect([style.outlineStyle, style.outlineWidth, style.outlineOffset]).toEqual([
      "solid",
      "2px",
      "2px",
    ]);
    expect(ringSpread(focused)).toBe(0);
    expect(style.transitionProperty).not.toMatch(/outline|all/);
  });

  it("has room in the scrolling track for the outline and the ring", async () => {
    render(() => (
      <Ground>
        <DietaryPresets value={["vegan"]} onChange={() => {}} />
      </Ground>
    ));
    const chosen = pill("Vegan");
    let scroller = chosen.parentElement!;
    while (getComputedStyle(scroller).overflowX !== "auto") scroller = scroller.parentElement!;
    const clip = scroller.getBoundingClientRect();
    const padding = getComputedStyle(scroller);
    for (const side of [padding.paddingTop, padding.paddingBottom, padding.paddingLeft]) {
      expect(Number.parseFloat(side)).toBeGreaterThanOrEqual(4);
    }
    const box = chosen.getBoundingClientRect();
    expect(box.top - clip.top).toBeGreaterThanOrEqual(4);
    expect(clip.bottom - box.bottom).toBeGreaterThanOrEqual(4);
  });
});

describe("a pill's motion", () => {
  const LADDER = {
    "--dur-fast": "70ms",
    "--dur-base": "170ms",
    "--ease-out": "cubic-bezier(0.1, 0.9, 0.2, 1)",
    "--ease-in-out": "cubic-bezier(0.6, 0, 0.4, 1)",
  } as JSX.CSSProperties;

  it("hovers on the fast step and the house curve, and ticks on the base step", () => {
    render(() => (
      <Ground style={LADDER}>
        <DietaryPresets value={["vegan"]} onChange={() => {}} wrap />
      </Ground>
    ));
    const clock = (el: Element) => {
      const style = getComputedStyle(el);
      return [style.transitionDuration, style.transitionTimingFunction];
    };
    expect(clock(pill("Vegetarian"))).toEqual(["0.07s", "cubic-bezier(0.1, 0.9, 0.2, 1)"]);
    expect(clock(pill("Vegan"))).toEqual(["0.17s", "cubic-bezier(0.6, 0, 0.4, 1)"]);
  });
});

describe("the quiet words", () => {
  for (const ramp of RAMPS) {
    it(`draws a band's label in the secondary ink, ${ramp}`, () => {
      const { container } = render(() => (
        <Ground ramp={ramp}>
          <DietaryPresets value={[]} onChange={() => {}} wrap />
        </Ground>
      ));
      const label = container.querySelector("fieldset p")!;
      expect(painted(getComputedStyle(label).color)).toBe(
        painted(token(label, "--ui-ink-secondary")),
      );
    });
  }

  it("draws the organiser's trigger at the portals' 34px, its empty words and caret secondary", async () => {
    // The trigger draws only on a wide screen; below it the pills are inline.
    await page.viewport(1024, 800);
    render(() => (
      <Ground>
        <DietaryPresetsPopover value={[]} onChange={() => {}} />
      </Ground>
    ));
    const trigger = await screen.findByRole("button");
    expect(trigger.getBoundingClientRect().height).toBe(34);
    for (const word of trigger.querySelectorAll("span")) {
      expect(painted(getComputedStyle(word).color)).toBe(
        painted(token(word, "--ui-ink-secondary")),
      );
    }
    await page.viewport(414, 896);
  });
});
