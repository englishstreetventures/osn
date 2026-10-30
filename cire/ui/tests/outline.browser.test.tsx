/**
 * `Button variant="outline"`, measured in Chromium against cire's two ramps.
 *
 * The portals' secondary action: a 40% gold edge and a gold word, at every
 * `outline` in the organiser and vendor portals. Under the pointer the edge
 * turns full gold and nothing else moves: a gold wash behind the gold word
 * takes the light ramp's word to 3.90:1 on the page. Each case is one way it can fail
 * the person pointing at it, on every ground an outline sits on in the
 * portals — the page, each card fill and the raised surface of a dialog: the
 * word falls under 4.5:1, a wash comes back, or the hover shows nothing.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import Button from "../src/button";
import { type CardFill, cardClass } from "../src/card";
import { composite, inkRatio } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

/** Every ground an outline button sits on in the portals. */
const GROUNDS: readonly { name: string; class: string }[] = [
  { name: "the page", class: "" },
  ...(["wash", "well", "opaque"] as const satisfies readonly CardFill[]).map((fill) => ({
    name: `a card (${fill} fill)`,
    class: cardClass({ fill }),
  })),
  { name: "the raised surface", class: "bg-ui-surface-raised" },
];

afterEach(cleanup);

function OnGround(props: { ramp: Ramp; class: string; children: JSX.Element }) {
  return (
    <div data-ramp={props.ramp === "light" ? "light" : undefined} class="bg-ui-ground p-4">
      <div class={`p-4 ${props.class}`}>{props.children}</div>
    </div>
  );
}

async function settled(el: Element) {
  await Promise.all(el.getAnimations().map((a) => a.finished));
}

describe('Button variant="outline"', () => {
  for (const ramp of RAMPS) {
    for (const ground of GROUNDS) {
      it(`holds its word at 4.5:1 at rest and under the pointer on ${ground.name}, ${ramp}`, async () => {
        render(() => (
          <OnGround ramp={ramp} class={ground.class}>
            <Button variant="outline">Add an event</Button>
          </OnGround>
        ));
        const button = screen.getByRole("button");
        expect(inkRatio(button)).toBeGreaterThanOrEqual(4.5);
        await userEvent.hover(button);
        await settled(button);
        expect(inkRatio(button)).toBeGreaterThanOrEqual(4.5);
      });
    }

    it(`paints no wash under the pointer, ${ramp}`, async () => {
      render(() => (
        <OnGround ramp={ramp} class="">
          <Button variant="outline">Add an event</Button>
        </OnGround>
      ));
      const button = screen.getByRole("button");
      const rest = getComputedStyle(button).backgroundColor;
      await userEvent.hover(button);
      await settled(button);
      expect(getComputedStyle(button).backgroundColor).toBe(rest);
    });

    it(`turns its edge full gold under the pointer, ${ramp}`, async () => {
      // Without a wash the edge is the hover's only sign.
      render(() => (
        <OnGround ramp={ramp} class="">
          <Button variant="outline">Add an event</Button>
        </OnGround>
      ));
      const button = screen.getByRole("button");
      const style = getComputedStyle(button);
      const ground = getComputedStyle(button.parentElement!.parentElement!).backgroundColor;
      const accent = composite([ground, style.getPropertyValue("--ui-accent").trim()]);
      expect(composite([ground, style.borderTopColor])).not.toEqual(accent);
      await userEvent.hover(button);
      await settled(button);
      expect(composite([ground, getComputedStyle(button).borderTopColor])).toEqual(accent);
    });
  }
});
