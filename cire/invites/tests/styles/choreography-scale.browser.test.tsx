/**
 * The guest site's choreography longer than `--dur-slow` — the bloom fill on
 * Respond, the tick drawn behind it, and the hero scroll cue's entry and
 * drift — read off the engine at two values of `--motion-scale`.
 *
 * `--motion-scale` slows every cire duration so a motion can be judged frame
 * by frame (`cire/invites/DESIGN.md` §5). A time written as a literal runs at
 * full speed whatever the scale says, and an easing written as a CSS keyword
 * runs the browser's curve rather than the house one. Neither shows in a class
 * or a regex over the stylesheet; both show in what `getComputedStyle` and an
 * animation's timing report.
 *
 * The times are `rsvp-responded.ts`'s constants, which the sheet's tests and
 * timers share, so the stylesheet and the script are held to one number. The
 * curves are read off the root's `--ease-out` and `--ease-in-out`, so the
 * tokens decide them, not this file.
 */
import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it } from "vitest";

import "../../src/styles/global.css";
import { EventCard } from "../../src/components/EventCard";
import { HeroScrollCue } from "../../src/components/HeroScrollCue";
import {
  SWEEP_DURATION_MS,
  TICK_DELAY_MS,
  TICK_DURATION_MS,
} from "../../src/components/rsvp-responded";
import type { EventSummary } from "../../src/components/types";

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "An evening of henna",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: "12 Banksia Lane",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

const noop = () => {};

/** A house easing token as the engine serialises it. */
function token(name: "--ease-out" | "--ease-in-out"): string {
  const probe = document.createElement("div");
  probe.style.transitionTimingFunction = `var(${name})`;
  document.body.append(probe);
  const value = getComputedStyle(probe).transitionTimingFunction;
  probe.remove();
  return value;
}

function setScale(scale: number) {
  document.documentElement.style.setProperty("--motion-scale", String(scale));
}

afterEach(() => {
  document.documentElement.style.removeProperty("--motion-scale");
});

/** A card whose household has just replied: the fill sweeping, the tick drawing. */
function celebratingCard() {
  const [justResponded, setJustResponded] = createSignal(false);
  const { container } = render(() => (
    <EventCard event={event} justResponded={justResponded()} onRespond={noop} onDetails={noop} />
  ));
  setJustResponded(true);
  const respond = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "RSVP given",
  )!;
  const fill = respond.querySelector<HTMLElement>("span[aria-hidden='true']")!;
  const tick = respond.querySelector<SVGPathElement>("svg path")!;
  const draw = (tick.getAnimations() as CSSAnimation[]).find(
    (a) => a.animationName === "tick-draw",
  );
  return { fill, tick, draw };
}

function scrollCue() {
  const { container } = render(() => (
    <section class="relative h-96">
      <HeroScrollCue />
    </section>
  ));
  const glyph = container.querySelector<SVGSVGElement>("[data-scroll-cue] svg")!;
  const all = glyph.getAnimations() as CSSAnimation[];
  return {
    glyph,
    entry: all.find((a) => a.animationName === "scroll-cue-in"),
    drift: all.find((a) => a.animationName === "scroll-cue-drift"),
  };
}

describe.each([1, 2])("at --motion-scale %d", (scale) => {
  it("sweeps the bloom fill over the sweep time times the scale, on --ease-out", () => {
    setScale(scale);
    const { fill } = celebratingCard();
    const style = getComputedStyle(fill);
    expect(style.transitionDuration).toBe(`${(SWEEP_DURATION_MS * scale) / 1000}s`);
    expect(style.transitionTimingFunction).toBe(token("--ease-out"));
  });

  it("draws the tick over its time and after its delay, each times the scale, on --ease-out", () => {
    setScale(scale);
    const { tick, draw } = celebratingCard();
    expect(draw, "no tick-draw animation on the tick").toBeTruthy();
    expect(draw!.effect!.getTiming()).toMatchObject({
      duration: TICK_DURATION_MS * scale,
      delay: TICK_DELAY_MS * scale,
    });
    expect(getComputedStyle(tick).animationTimingFunction).toBe(token("--ease-out"));
  });

  it("fades the scroll cue in on --ease-out and drifts it on --ease-in-out, every time times the scale", () => {
    setScale(scale);
    const { glyph, entry, drift } = scrollCue();
    expect(entry?.effect?.getTiming()).toMatchObject({
      duration: 600 * scale,
      delay: 1000 * scale,
    });
    expect(drift?.effect?.getTiming()).toMatchObject({
      duration: 2000 * scale,
      delay: 1600 * scale,
      iterations: 2,
    });
    expect(getComputedStyle(glyph).animationTimingFunction).toBe(
      `${token("--ease-out")}, ${token("--ease-in-out")}`,
    );
  });
});
