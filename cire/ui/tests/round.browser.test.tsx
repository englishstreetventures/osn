/**
 * `Button variant="round"`, measured in Chromium against cire's two ramps.
 *
 * A round button is a glyph on an opaque disc: the reply key beside the RSVP
 * search box (28px) and the event sheet's close × (44px), which must hide
 * what scrolls under it. Each case is one way it can stop being that: it
 * loses the disc, gains an edge, comes out the wrong size or shape, washes
 * its fill under the pointer, shows nothing while its popover is open, draws
 * the wrong ring, or lets its glyph fall under 4.5:1.
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import Button, { type ButtonSize } from "../src/button";
import { composite, inkRatio, painted } from "./test-support/paint";

import "./test-support/tailwind.css";

const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

function Ramp(props: { ramp: Ramp; children: JSX.Element }) {
  return (
    <div data-ramp={props.ramp === "light" ? "light" : undefined} class="bg-ui-ground p-4">
      {props.children}
    </div>
  );
}

function token(from: Element, name: string): string {
  return getComputedStyle(from).getPropertyValue(name).trim();
}

/** A colour as painted over `under`, so translucent and opaque values compare. */
function over(under: string, color: string): string {
  return composite([under, color]).join(",");
}

async function settled(el: Element) {
  await Promise.all(el.getAnimations().map((a) => a.finished));
}

function Round(props: { size?: ButtonSize; label?: string; "aria-expanded"?: "true" | "false" }) {
  return (
    <Button
      variant="round"
      size={props.size}
      aria-label={props.label ?? "Close"}
      aria-expanded={props["aria-expanded"]}
    >
      <span aria-hidden="true">×</span>
    </Button>
  );
}

describe('Button variant="round"', () => {
  for (const ramp of RAMPS) {
    it(`sits on the surface fill with no visible edge, ${ramp}`, () => {
      render(() => (
        <Ramp ramp={ramp}>
          <Round />
        </Ramp>
      ));
      const button = screen.getByRole("button");
      const style = getComputedStyle(button);
      const ground = getComputedStyle(button.parentElement!).backgroundColor;
      expect(over(ground, style.backgroundColor)).toBe(over(ground, token(button, "--ui-surface")));
      // Opaque: content scrolling under the sheet's close × must not show.
      expect(composite([style.backgroundColor])).toEqual(
        composite(["#000", style.backgroundColor]),
      );
      expect(style.borderTopColor).toBe("rgba(0, 0, 0, 0)");
    });

    it(`holds its glyph at 4.5:1 on its own fill, ${ramp}`, () => {
      render(() => (
        <Ramp ramp={ramp}>
          <Round />
        </Ramp>
      ));
      expect(inkRatio(screen.getByRole("button"))).toBeGreaterThanOrEqual(4.5);
    });

    it(`marks an open popover with the raised surface and the body ink, ${ramp}`, () => {
      render(() => (
        <Ramp ramp={ramp}>
          <Round label="closed" aria-expanded="false" />
          <Round label="open" aria-expanded="true" />
        </Ramp>
      ));
      const open = screen.getByRole("button", { name: "open" });
      const closed = screen.getByRole("button", { name: "closed" });
      const ground = getComputedStyle(open.parentElement!).backgroundColor;
      expect(over(ground, getComputedStyle(open).backgroundColor)).toBe(
        over(ground, token(open, "--ui-surface-raised")),
      );
      expect(over(ground, getComputedStyle(open).color)).toBe(
        over(ground, token(open, "--ui-ink")),
      );
      expect(over(ground, getComputedStyle(closed).backgroundColor)).toBe(
        over(ground, token(closed, "--ui-surface")),
      );
    });
  }

  const SIDES = { sm: 28, md: 32, icon: 32, lg: 44 } as const satisfies Partial<
    Record<ButtonSize, number>
  >;
  for (const [size, side] of Object.entries(SIDES) as [ButtonSize, number][]) {
    it(`is a ${side}px circle at size ${size}`, () => {
      render(() => <Round size={size} />);
      const button = screen.getByRole("button");
      const box = button.getBoundingClientRect();
      expect(box.width).toBe(side);
      expect(box.height).toBe(side);
      expect(
        Number.parseFloat(getComputedStyle(button).borderTopLeftRadius),
      ).toBeGreaterThanOrEqual(side / 2);
    });
  }

  it("sets the close × on the contract's large text step", () => {
    render(() => <Round size="lg" />);
    const button = screen.getByRole("button");
    const probe = document.createElement("span");
    probe.style.fontSize = "var(--ui-text-lg)";
    button.parentElement!.append(probe);
    expect(getComputedStyle(button).fontSize).toBe(getComputedStyle(probe).fontSize);
  });

  it("changes only its glyph under the pointer, to the body ink", async () => {
    render(() => <Round />);
    const button = screen.getByRole("button");
    const rest = getComputedStyle(button).backgroundColor;
    // Painted over the disc: the dark secondary ink is the body ink at 58%,
    // and on a bare canvas the two read back one unit apart.
    const ink = over(rest, token(button, "--ui-ink"));
    expect(over(rest, getComputedStyle(button).color)).not.toBe(ink);
    await userEvent.hover(button);
    await settled(button);
    expect(getComputedStyle(button).backgroundColor).toBe(rest);
    expect(over(rest, getComputedStyle(button).color)).toBe(ink);
  });

  it("draws a 2px focus ring in --ui-focus that does not fade in", async () => {
    render(() => <Round />);
    const button = screen.getByRole("button");
    await userEvent.tab();
    expect(document.activeElement).toBe(button);
    const style = getComputedStyle(button);
    expect(style.outlineStyle).toBe("solid");
    expect(style.outlineWidth).toBe("2px");
    expect(painted(style.outlineColor)).toBe(painted(token(button, "--ui-focus")));
    expect(style.transitionProperty).not.toMatch(/outline|all/);
  });
});
