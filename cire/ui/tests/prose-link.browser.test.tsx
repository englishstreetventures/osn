/**
 * `proseLinkClass`, measured where a reader sees it: a link inside a sentence.
 *
 * Each case is one way the link can stop being a link someone can read and
 * reach: it refuses to wrap with its sentence, it loses the underline that
 * marks it without colour (WCAG 1.4.1), its ring is the wrong colour or fades
 * in, its two tones paint alike, its ink drops under 4.5:1 on cire's grounds,
 * a hover does the wrong thing, or it brings a type size of its own into the
 * sentence. Every claim is read from computed style and layout in Chromium,
 * against cire's own two ramps (`test-support/tailwind.css`).
 */

import { cleanup, render, screen } from "@solidjs/testing-library";
import type { JSX } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import { type ProseLinkTone, proseLinkClass } from "../src/button";
import { composite, inkRatio, painted } from "./test-support/paint";

import "./test-support/tailwind.css";

const TONES = ["accent", "muted"] as const satisfies readonly ProseLinkTone[];
const RAMPS = ["dark", "light"] as const;
type Ramp = (typeof RAMPS)[number];

afterEach(cleanup);

/** A wrapper carrying one of cire's ramps, on the given ground. */
function Ramp(props: { ramp: Ramp; ground?: "ground" | "surface"; children: JSX.Element }) {
  return (
    <div
      data-ramp={props.ramp === "light" ? "light" : undefined}
      class={props.ground === "surface" ? "bg-ui-surface p-4" : "bg-ui-ground p-4"}
    >
      {props.children}
    </div>
  );
}

const LONG = "the privacy notice that explains what we keep about each guest and why";

/** A sentence with one link in it, the way every call site writes one. */
function Sentence(props: { tone?: ProseLinkTone; style?: JSX.CSSProperties; name?: string }) {
  return (
    <p class="text-ui-ink" style={props.style}>
      Dietary needs go to the caterer. See{" "}
      <a href="#notice" class={proseLinkClass(props.tone ? { tone: props.tone } : {})}>
        {props.name ?? LONG}
      </a>
      .
    </p>
  );
}

/** A custom property's value as painted, read on the element that declares the ramp. */
function token(from: Element, name: string): string {
  return getComputedStyle(from).getPropertyValue(name).trim();
}

async function settled(el: Element) {
  await Promise.all(el.getAnimations().map((a) => a.finished));
}

describe("proseLinkClass", () => {
  for (const tone of TONES) {
    it(`wraps with its sentence in a narrow paragraph (${tone})`, () => {
      render(() => <Sentence tone={tone} style={{ width: "10rem" }} />);
      const link = screen.getByRole("link");
      // Two or more line boxes, not a pixel height: Linux and macOS set the
      // same words at different widths, and either way 10rem is narrower than
      // the link's words.
      expect(link.getClientRects().length).toBeGreaterThanOrEqual(2);
    });

    it(`is underlined at rest, 2px below the text (${tone})`, () => {
      render(() => <Sentence tone={tone} name="privacy notice" />);
      const style = getComputedStyle(screen.getByRole("link"));
      expect(style.textDecorationLine).toBe("underline");
      expect(style.textUnderlineOffset).toBe("2px");
    });

    it(`takes the sentence's type size and weight (${tone})`, () => {
      render(() => <Sentence tone={tone} name="privacy notice" style={{ "font-size": "19px" }} />);
      const link = getComputedStyle(screen.getByRole("link"));
      const sentence = getComputedStyle(screen.getByRole("link").parentElement!);
      expect(link.fontSize).toBe("19px");
      expect(link.fontWeight).toBe(sentence.fontWeight);
    });

    it(`draws a 2px focus ring in --ui-focus that does not fade in (${tone})`, async () => {
      render(() => <Sentence tone={tone} name="privacy notice" />);
      const link = screen.getByRole("link");
      await userEvent.tab();
      expect(document.activeElement).toBe(link);
      const style = getComputedStyle(link);
      expect(style.outlineStyle).toBe("solid");
      expect(style.outlineWidth).toBe("2px");
      expect(style.outlineOffset).toBe("2px");
      expect(painted(style.outlineColor)).toBe(painted(token(link, "--ui-focus")));
      // A ring that is listed in the transition arrives over the hover's
      // duration rather than the moment focus lands.
      expect(style.transitionProperty).not.toMatch(/outline|all/);
    });

    for (const ramp of RAMPS) {
      for (const ground of ["ground", "surface"] as const) {
        it(`clears 4.5:1 on the ${ground}, ${ramp} (${tone})`, () => {
          render(() => (
            <Ramp ramp={ramp} ground={ground}>
              <Sentence tone={tone} name="privacy notice" />
            </Ramp>
          ));
          expect(inkRatio(screen.getByRole("link"))).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }

  it("paints accent in the readable gold and muted in the secondary ink", () => {
    render(() => (
      <Ramp ramp="dark">
        <Sentence tone="accent" name="accent link" />
        <Sentence tone="muted" name="muted link" />
      </Ramp>
    ));
    const accent = screen.getByRole("link", { name: "accent link" });
    const muted = screen.getByRole("link", { name: "muted link" });
    const ground = getComputedStyle(accent.closest("div")!).backgroundColor;
    const over = (color: string) => composite([ground, color]).join(",");
    expect(over(getComputedStyle(accent).color)).toBe(over(token(accent, "--ui-accent-ink")));
    expect(over(getComputedStyle(muted).color)).toBe(over(token(muted, "--ui-ink-secondary")));
    expect(over(getComputedStyle(accent).color)).not.toBe(over(getComputedStyle(muted).color));
  });

  it("defaults to the accent tone", () => {
    render(() => (
      <>
        <Sentence name="no tone" />
        <Sentence tone="accent" name="accent" />
      </>
    ));
    expect(getComputedStyle(screen.getByRole("link", { name: "no tone" })).color).toBe(
      getComputedStyle(screen.getByRole("link", { name: "accent" })).color,
    );
  });

  it("brightens a muted link to the body ink under the pointer", async () => {
    render(() => <Sentence tone="muted" name="muted link" />);
    const link = screen.getByRole("link");
    await userEvent.hover(link);
    await settled(link);
    expect(painted(getComputedStyle(link).color)).toBe(painted(token(link, "--ui-ink")));
  });

  it("leaves an accent link's ink as it is under the pointer", async () => {
    render(() => <Sentence tone="accent" name="accent link" />);
    const link = screen.getByRole("link");
    const rest = getComputedStyle(link).color;
    await userEvent.hover(link);
    await settled(link);
    expect(getComputedStyle(link).color).toBe(rest);
  });
});
