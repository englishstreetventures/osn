import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";

import { EventCard } from "../../src/components/EventCard";

import "../../src/styles/global.css";
import { SWEEP_DURATION_MS, TOTAL_DURATION_MS } from "../../src/components/rsvp-responded";
import type { EventSummary } from "../../src/components/types";

/**
 * The Respond button's recorded-reply confirmation, MEASURED.
 *
 * Every other assertion about this confirmation — `EventCard.test.tsx`,
 * `rsvp-confirmation.integration.test.tsx`, both `InvitePage` packs — runs in
 * happy-dom, which parses no stylesheet and computes no styles. They can only
 * state which classes are present at which moment. Two PRs (#395, #396) shipped
 * green against that contract and were both reported as still reverting the
 * fill, because the one property that matters to a guest is the one no test
 * could see: **what colour the button is painted, a few seconds later.**
 *
 * `vitest.config.ts` names the two mechanisms that make the class contract
 * insufficient here, and both apply to this exact element:
 *
 *   - Tailwind v4's `scale-*` utilities set the standalone `scale` property,
 *     not `transform`, so a `transition-transform` that stopped listing `scale`
 *     would animate nothing, silently.
 *   - Two conflicting utilities on one element resolve by **stylesheet order**,
 *     not class-attribute order — which is why the fill layer must never carry
 *     `scale-x-0` and `scale-x-100` at the same time. A class-presence test
 *     passes either way; only a computed-style read can tell which one won.
 *
 * So this file asserts the guest-visible facts: the fill travels, it lands
 * filled, and it is STILL filled long after every timer in
 * `rsvp-responded.ts` has run out.
 */

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

function respondButton(container: HTMLElement) {
  return [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Respond",
  ) as HTMLButtonElement;
}

/** The fill layer — the one `aria-hidden` span inside the Respond button. */
function fillLayer(container: HTMLElement) {
  return respondButton(container).querySelector("span[aria-hidden='true']") as HTMLElement;
}

/** `scale: 1` / `scale: 0 1` / `1 1` … — normalised to the x factor alone. */
function scaleX(el: HTMLElement): number {
  const raw = getComputedStyle(el).scale;
  if (raw === "none") return 1;
  return Number.parseFloat(raw.split(" ")[0]!);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The bloom token as this stylesheet actually resolves it. */
function bloom(container: HTMLElement): string {
  const probe = document.createElement("div");
  probe.className = "bg-bloom";
  container.append(probe);
  const painted = getComputedStyle(probe).backgroundColor;
  probe.remove();
  return painted;
}

describe("EventCard — the Respond confirmation, painted", () => {
  it("sweeps the fill on and leaves it on, long after every timer has run out", async () => {
    const [justResponded, setJustResponded] = createSignal(false);
    const [responded, setResponded] = createSignal(false);
    const { container } = render(() => (
      <EventCard
        event={event}
        responded={responded()}
        justResponded={justResponded()}
        onRespond={noop}
        onDetails={noop}
      />
    ));
    const fill = fillLayer(container);

    // Before any reply: no fill at all.
    expect(scaleX(fill)).toBe(0);

    // The real submit path records the reply and cues the celebration as the
    // sheet leaves, so both flip together here.
    setResponded(true);
    setJustResponded(true);

    // Mid-sweep: travelling, not jumped. This is the assertion that proves the
    // transition is wired to the standalone `scale` property Tailwind v4 writes
    // — the mechanism whose failure mode is silent — so it must not be flaky.
    //
    // Driven through the Web Animations API rather than a `wait(250)`: a sleep
    // against a 500ms transition has a hard UPPER bound, and one 250ms long task
    // (a full-stylesheet recalc, GC, a co-scheduled browser file) reads it as
    // already landed. Pausing the CSSTransition and setting `currentTime`
    // measures the same guest-visible fact with no dependence on the scheduler.
    const sweep = fill.getAnimations()[0];
    expect(
      sweep,
      "no transition on the fill — is `transition-transform` still listing `scale`?",
    ).toBeTruthy();
    // Asserted before the sample so a clamped transition (the reduced-motion
    // block sets 0.01ms) fails on its cause rather than as a confusing
    // `scale === 1`. Doubles as a precondition check against media emulation
    // leaking in from a sibling browser file.
    expect(getComputedStyle(fill).transitionDuration).toBe(`${SWEEP_DURATION_MS / 1000}s`);
    sweep!.pause();
    sweep!.currentTime = SWEEP_DURATION_MS / 2;
    const midway = scaleX(fill);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(1);

    // Landed.
    sweep!.play();
    await wait(SWEEP_DURATION_MS);
    expect(scaleX(fill)).toBe(1);
    expect(getComputedStyle(fill).backgroundColor).toBe(bloom(container));

    // …and STILL landed, two full seconds past the end of the choreography.
    // This is the assertion the last two attempts were missing.
    await wait(TOTAL_DURATION_MS + 2000);
    expect(scaleX(fill)).toBe(1);
    expect(getComputedStyle(fill).backgroundColor).toBe(bloom(container));

    // The tick outlives the celebration too — it is the permanent mark, not a
    // flourish.
    expect(respondButton(container).querySelector("svg")).not.toBeNull();
  });

  it("paints a reply already on file as filled from the first frame", async () => {
    const { container } = render(() => (
      <EventCard event={event} responded onRespond={noop} onDetails={noop} />
    ));
    // No transition to wait through: a guest reopening the invite tomorrow sees
    // the settled state, they don't watch it draw.
    expect(scaleX(fillLayer(container))).toBe(1);
    await wait(TOTAL_DURATION_MS + 500);
    expect(scaleX(fillLayer(container))).toBe(1);
  });

  it("never carries both scale utilities, in either state", async () => {
    const [justResponded, setJustResponded] = createSignal(false);
    const { container } = render(() => (
      <EventCard event={event} justResponded={justResponded()} onRespond={noop} onDetails={noop} />
    ));
    const fill = fillLayer(container);
    const both = () =>
      fill.classList.contains("scale-x-0") && fill.classList.contains("scale-x-100");

    // Two conflicting utilities resolve by stylesheet order, which is a
    // property of Tailwind's OUTPUT and can invert under a version bump. Never
    // emitting both is what makes the state unambiguous.
    expect(both()).toBe(false);
    setJustResponded(true);
    await wait(SWEEP_DURATION_MS + 100);
    expect(both()).toBe(false);
    expect(scaleX(fill)).toBe(1);
  });
});
