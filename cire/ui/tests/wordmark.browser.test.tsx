/**
 * The top bar's wordmark, measured in Chromium against cire's two ramps.
 *
 * Each case is one way it can stop being the mark the owner chose: a star or
 * a word that reads under 4.5:1 on the bar or on its hover wash, a hover that
 * paints no wash, a focus ring that is not the house ring or that fades in,
 * and a ring that runs into the divider beside it in the bars' `gap-2` row.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { commands, userEvent } from "vitest/browser";

import Wordmark, { WordmarkPlaceholder } from "../src/wordmark";
import { composite, inkRatio, painted } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

type MediaPreference = { reducedMotion?: "reduce" | "no-preference" };
const emulateMedia = (options: MediaPreference) =>
  (commands as unknown as { emulateMedia: (o: MediaPreference) => Promise<void> }).emulateMedia(
    options,
  );

afterEach(async () => {
  await emulateMedia({ reducedMotion: "no-preference" });
  cleanup();
});

/**
 * The bars' left end: the page's ground, a `gap-2` row, the mark, a 1px
 * divider, a section label. The row's 16px padding stands in for the page
 * frame's gutter, so the mark's pull to the left has room.
 */
function Bar(props: { ramp: Ramp; children: JSX.Element }) {
  return (
    <div data-ramp={props.ramp === "light" ? "light" : undefined} class="bg-ui-ground">
      <div data-row class="flex h-14 items-center gap-2 px-4">
        {props.children}
        <span data-divider aria-hidden="true" class="bg-ui-hairline h-5 w-px shrink-0" />
        <span class="text-ui-xs">All weddings</span>
      </div>
    </div>
  );
}

function renderBar(ramp: Ramp) {
  render(() => (
    <Bar ramp={ramp}>
      <Wordmark label="Cire — all weddings" onClick={() => {}} />
    </Bar>
  ));
  const button = screen.getByRole("button", { name: "Cire — all weddings" });
  const [star, word] = [...button.children] as [HTMLElement, HTMLElement];
  return { button, star, word };
}

function token(from: Element, name: string): string {
  return getComputedStyle(from).getPropertyValue(name).trim();
}

async function settled(el: Element) {
  await Promise.all(el.getAnimations().map((a) => a.finished));
}

describe("Wordmark", () => {
  for (const ramp of RAMPS) {
    it(`holds the star and the word at 4.5:1 on the bar, ${ramp}`, () => {
      const { star, word } = renderBar(ramp);
      expect(inkRatio(star)).toBeGreaterThanOrEqual(4.5);
      expect(inkRatio(word)).toBeGreaterThanOrEqual(4.5);
    });

    it(`washes under the pointer and keeps both at 4.5:1 on the wash, ${ramp}`, async () => {
      const { button, star, word } = renderBar(ramp);
      const ground = getComputedStyle(button.parentElement!.parentElement!).backgroundColor;
      await userEvent.hover(button);
      await settled(button);
      const wash = getComputedStyle(button).backgroundColor;
      expect(composite([ground, wash])).not.toEqual(composite([ground]));
      expect(inkRatio(star)).toBeGreaterThanOrEqual(4.5);
      expect(inkRatio(word)).toBeGreaterThanOrEqual(4.5);
      await userEvent.unhover(button);
    });

    it(`draws the house ring on keyboard focus, at once, ${ramp}`, async () => {
      const { button } = renderBar(ramp);
      await userEvent.tab();
      expect(document.activeElement).toBe(button);
      const style = getComputedStyle(button);
      expect(style.outlineStyle).toBe("solid");
      expect(style.outlineWidth).toBe("2px");
      expect(style.outlineOffset).toBe("2px");
      expect(painted(style.outlineColor)).toBe(painted(token(button, "--ui-focus")));
      expect(style.transitionProperty).not.toMatch(/outline|all/);
    });
  }

  it("keeps its ring clear of the divider, and its star on the page edge", async () => {
    const { button } = renderBar("dark");
    const row = button.parentElement!;
    const divider = row.querySelector("[data-divider]")!;
    await userEvent.tab();
    const box = button.getBoundingClientRect();
    const style = getComputedStyle(button);
    const ringReach = parseFloat(style.outlineOffset) + parseFloat(style.outlineWidth);
    // The ring's outer edge — the box plus the painted outline's offset and
    // width, which a bounding rect leaves out — and the gap left to the divider.
    const clear = divider.getBoundingClientRect().left - (box.right + ringReach);
    expect(clear).toBeGreaterThanOrEqual(3.5);
    // The pull to the left: the box starts 4px before the row's content edge,
    // and its 6px padding puts the star 2px inside it.
    const contentLeft =
      row.getBoundingClientRect().left + parseFloat(getComputedStyle(row).paddingLeft);
    expect(contentLeft - box.left).toBeCloseTo(4, 1);
    const star = button.firstElementChild!.getBoundingClientRect();
    expect(star.left - contentLeft).toBeCloseTo(2, 1);
    expect(style.paddingTop).toBe("6px");
  });

  it("fades its wash on the app's ease-out, and not at all with reduced motion", async () => {
    const { button } = renderBar("dark");
    // The app's `--ease-out`: the portals set the house curve; here it is
    // Tailwind's own, which is what an app that sets none gets.
    const squash = (value: string) => value.replace(/\s+/g, "");
    expect(squash(getComputedStyle(button).transitionTimingFunction)).toBe(
      squash(token(button, "--ease-out")),
    );
    await emulateMedia({ reducedMotion: "reduce" });
    expect(getComputedStyle(button).transitionProperty).toBe("none");
  });

  for (const ramp of RAMPS) {
    it(`lands the boot bar's copy on the button's glyphs, ${ramp}`, () => {
      // Two bars of the same shape, one over the other: each glyph must sit at
      // the same x in both, and at the same height within its bar.
      const { container } = render(() => (
        <>
          <Bar ramp={ramp}>
            <WordmarkPlaceholder />
          </Bar>
          <Bar ramp={ramp}>
            <Wordmark label="Cire — all weddings" onClick={() => {}} />
          </Bar>
        </>
      ));
      const [bootRow, islandRow] = [...container.querySelectorAll("[data-row]")] as HTMLElement[];
      const glyphs = (row: HTMLElement) =>
        [...row.firstElementChild!.children].map((g) => {
          const rect = g.getBoundingClientRect();
          const top = row.getBoundingClientRect().top;
          return [rect.left, rect.top - top, rect.width, rect.height].map((n) => n.toFixed(2));
        });
      expect(glyphs(bootRow!)).toEqual(glyphs(islandRow!));
    });
  }
});
