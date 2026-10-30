/**
 * `Button variant="choice"`, measured in Chromium against cire's two ramps.
 *
 * A choice is one answer among several with the chosen one marked: the guest
 * sheet's Attending and Not attending, the host's preview toggle, palette
 * presets and registry pictures. Each case is one way it can fail the person
 * choosing: the answer they just gave fades while it saves, a locked answer
 * still takes a click or still reacts to the pointer, the host's busy pictures
 * stop fading, chosen and unchosen look alike, the hover stops sitting halfway
 * between the two, a chosen radio loses its ring under the pointer, a word
 * falls under 4.5:1, or the colours move on the wrong clock.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import Button from "../src/button";
import { composite, inkRatio } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

function Ramp(props: { ramp?: Ramp; children: JSX.Element }) {
  return (
    <div data-ramp={props.ramp === "light" ? "light" : undefined} class="bg-ui-ground p-4">
      {props.children}
    </div>
  );
}

/** A colour as painted over the element's backdrop, as `[r, g, b]`. */
function onGround(el: Element, color: string): [number, number, number] {
  const ground = getComputedStyle(el.parentElement!).backgroundColor;
  return composite([ground, color]);
}

function distance(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(...a.map((v, i) => v - b[i]!));
}

/** The colour a `box-shadow` ring paints, or `none`. */
function ringColor(el: Element): string {
  const shadow = getComputedStyle(el).boxShadow;
  if (shadow === "none") return "none";
  // Chromium writes the colour first: "oklch(… / 0.6) 0px 0px 0px 1px, …".
  const rings = shadow.split(/,(?![^(]*\))/).map((s) => s.trim());
  const visible = rings.find((r) => !r.startsWith("rgba(0, 0, 0, 0)") && !/\/ 0\)/.test(r));
  return visible ? visible.replace(/\s+-?\d+(\.\d+)?px.*$/, "") : "none";
}

async function settled(el: Element) {
  await Promise.all(el.getAnimations().map((a) => a.finished));
}

/** Rest, so a later assertion can say "nothing changed". */
function look(el: Element) {
  const style = getComputedStyle(el);
  return {
    border: style.borderTopColor,
    color: style.color,
    shadow: style.boxShadow,
    opacity: style.opacity,
  };
}

describe('Button variant="choice"', () => {
  it("keeps a locked, chosen answer at full strength and swallows its click", async () => {
    let clicks = 0;
    render(() => (
      <Ramp>
        <Button
          variant="choice"
          aria-pressed="true"
          aria-disabled="true"
          onClick={() => {
            clicks += 1;
          }}
        >
          Attending
        </Button>
      </Ramp>
    ));
    const answer = screen.getByRole("button", { name: "Attending" });
    expect(getComputedStyle(answer).opacity).toBe("1");
    await userEvent.click(answer, { force: true });
    expect(clicks).toBe(0);
    expect(getComputedStyle(answer).cursor).toBe("not-allowed");
  });

  it("does not fade the unchosen answer while the pair is locked", () => {
    render(() => (
      <Ramp>
        <Button variant="choice" aria-pressed="false" aria-disabled="true">
          Not attending
        </Button>
      </Ramp>
    ));
    expect(getComputedStyle(screen.getByRole("button")).opacity).toBe("1");
  });

  it("does not answer the pointer while locked", async () => {
    render(() => (
      <Ramp>
        <Button variant="choice" aria-pressed="false" aria-disabled="true">
          Not attending
        </Button>
      </Ramp>
    ));
    const answer = screen.getByRole("button");
    const rest = look(answer);
    await userEvent.hover(answer);
    await settled(answer);
    expect(look(answer)).toEqual(rest);
  });

  it("still fades a disabled choice, as the host's busy pictures do", () => {
    render(() => (
      <Ramp>
        <Button variant="choice" size="swatch" disabled aria-label="Picture 1">
          <span class="block size-10" />
        </Button>
      </Ramp>
    ));
    expect(getComputedStyle(screen.getByRole("button")).opacity).toBe("0.4");
  });

  for (const ramp of RAMPS) {
    it(`marks the chosen answer with an edge and a ring the unchosen one lacks, ${ramp}`, () => {
      render(() => (
        <Ramp ramp={ramp}>
          <Button variant="choice" aria-pressed="true">
            Attending
          </Button>
          <Button variant="choice" aria-pressed="false">
            Not attending
          </Button>
        </Ramp>
      ));
      const chosen = screen.getByRole("button", { name: "Attending" });
      const other = screen.getByRole("button", { name: "Not attending" });
      expect(onGround(chosen, getComputedStyle(chosen).borderTopColor)).not.toEqual(
        onGround(other, getComputedStyle(other).borderTopColor),
      );
      // The ring doubles the edge's weight: the sign that is not colour alone.
      expect(ringColor(chosen)).not.toBe("none");
      expect(ringColor(other)).toBe("none");
    });

    it(`goes halfway from rest to chosen under the pointer, ${ramp}`, async () => {
      render(() => (
        <Ramp ramp={ramp}>
          <Button variant="choice" aria-pressed="true">
            Attending
          </Button>
          <Button variant="choice" aria-pressed="false">
            Not attending
          </Button>
        </Ramp>
      ));
      const chosen = screen.getByRole("button", { name: "Attending" });
      const other = screen.getByRole("button", { name: "Not attending" });
      const restEdge = onGround(other, getComputedStyle(other).borderTopColor);
      const chosenEdge = onGround(chosen, getComputedStyle(chosen).borderTopColor);
      const chosenRing = onGround(chosen, ringColor(chosen));
      await userEvent.hover(other);
      await settled(other);
      const hoverEdge = onGround(other, getComputedStyle(other).borderTopColor);
      const share = distance(restEdge, hoverEdge) / distance(restEdge, chosenEdge);
      expect(share).toBeGreaterThan(0.3);
      expect(share).toBeLessThan(0.7);
      // A ring arrives, fainter than the chosen answer's.
      expect(ringColor(other)).not.toBe("none");
      const ground = onGround(other, "transparent");
      expect(distance(ground, onGround(other, ringColor(other)))).toBeLessThan(
        distance(ground, chosenRing),
      );
      expect(inkRatio(other)).toBeGreaterThanOrEqual(4.5);
    });

    it(`holds every word at 4.5:1, chosen and not, ${ramp}`, () => {
      render(() => (
        <Ramp ramp={ramp}>
          <Button variant="choice" aria-pressed="true">
            Attending
          </Button>
          <Button variant="choice" aria-pressed="false">
            Not attending
          </Button>
        </Ramp>
      ));
      for (const name of ["Attending", "Not attending"]) {
        expect(inkRatio(screen.getByRole("button", { name }))).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it("keeps a chosen radio's ring under the pointer", async () => {
    render(() => (
      <Ramp>
        <div role="radiogroup" aria-label="Picture">
          {/* A radio group of `Button`s, as the registry's picture picker draws
              one: the case is the `aria-checked` half of the chosen mark. */}
          {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role */}
          <Button variant="choice" role="radio" aria-checked="true">
            Sage
          </Button>
        </div>
      </Ramp>
    ));
    const chosen = screen.getByRole("radio");
    const rest = look(chosen);
    await userEvent.hover(chosen);
    await settled(chosen);
    expect(look(chosen)).toEqual(rest);
  });

  it("moves its colours and ring on the base duration, never the focus ring", () => {
    render(() => (
      <Ramp>
        <Button variant="choice">Phone</Button>
      </Ramp>
    ));
    const style = getComputedStyle(screen.getByRole("button"));
    expect(style.transitionProperty.split(", ")).toEqual(
      expect.arrayContaining(["color", "background-color", "border-color", "box-shadow"]),
    );
    expect(style.transitionProperty).not.toMatch(/outline|all/);
    expect(style.transitionDuration).toBe("0.15s");
  });

  it("lets a caller's plain hover class win over its own", async () => {
    render(() => (
      <Ramp>
        <Button variant="choice" class="hover:border-ui-danger">
          Phone
        </Button>
      </Ramp>
    ));
    const button = screen.getByRole("button");
    await userEvent.hover(button);
    await settled(button);
    expect(onGround(button, getComputedStyle(button).borderTopColor)).toEqual(
      onGround(button, getComputedStyle(button).getPropertyValue("--ui-danger").trim()),
    );
  });
});
