import { render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";

import "../../src/styles/global.css";
import { RsvpModal } from "../../src/components/RsvpModal";
import type { EventSummary, FamilyMember } from "../../src/components/types";

/**
 * The RSVP sheet's sticky action bar, measured.
 *
 * `cire/CLAUDE.md` states the rule this file exists to enforce, and states in
 * the same breath why no other test can:
 *
 *   > A `position: sticky` box resolves its `bottom` offset against the
 *   > SCROLLPORT, not against its parent's content box — so the usual "cancel
 *   > the container's padding with a negative margin" trick inverts on a sticky
 *   > element: a negative bottom margin *hoists it up* over the content instead
 *   > of stretching it down into the padding. […] Layout bugs of this shape are
 *   > invisible to the test tier (jsdom/happy-dom compute no layout), so pin the
 *   > class contract in tests and measure the real thing in a browser.
 *
 * `RsvpModal.test.tsx` does the first half — it pins `pb-0`, `-mx-6`, `px-6`,
 * `sticky`, and the absence of any `-mb-*`. This is the second half. The class
 * contract cannot catch a regression that arrives through `AnimatedModal`
 * (dropping `flushBottom`, or making the panel a scroll container), through a
 * Tailwind upgrade, or through any change that satisfies every asserted class
 * and still lays out wrong.
 */

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "Henna evening",
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

/** Enough of a party to overflow the sheet, so the scrollport is real. */
const members: FamilyMember[] = Array.from({ length: 12 }, (_, i) => ({
  guestId: `guest-${i}`,
  firstName: `Guest${i}`,
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
}));

function open() {
  const view = render(() => (
    <RsvpModal event={event} members={members} apiUrl="https://api.test" onClose={() => {}} />
  ));
  const panel = document.querySelector('[role="dialog"]') as HTMLElement;
  const scroller = panel.lastElementChild as HTMLElement;
  const bar = view.getByRole("button", { name: "Save" }).parentElement as HTMLElement;
  return { ...view, panel, scroller, bar };
}

describe("RSVP action bar, as laid out", () => {
  it("gives the sheet a scrollport that actually scrolls", () => {
    // Everything below is vacuous without this — and in jsdom it is always
    // false, because no layout is computed at all.
    const { scroller } = open();
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
  });

  it("seats the bar ON the scrollport's bottom edge, not hoisted above it", () => {
    // The exact inversion the rule is about: a negative bottom margin would lift
    // the bar up over the last card, leaving a gap below it. Both edges must
    // coincide.
    const { scroller, bar } = open();
    const gap = scroller.getBoundingClientRect().bottom - bar.getBoundingClientRect().bottom;
    expect(Math.abs(gap)).toBeLessThan(1);
  });

  it("keeps the bar in view while the content scrolls under it", () => {
    // `sticky` doing its job. If the panel ever became the scroll container, or
    // an ancestor gained `overflow: hidden`, sticky would silently degrade to
    // static and the bar would scroll away with the content.
    const { scroller, bar } = open();
    const before = bar.getBoundingClientRect().bottom;

    scroller.scrollTop = 0;
    const atTop = bar.getBoundingClientRect().bottom;
    scroller.scrollTop = scroller.scrollHeight;
    const atBottom = bar.getBoundingClientRect().bottom;

    expect(Math.abs(atTop - before)).toBeLessThan(1);
    expect(Math.abs(atBottom - atTop)).toBeLessThan(1);
    // And it is genuinely inside the visible scrollport at both extremes.
    const port = scroller.getBoundingClientRect();
    expect(atTop).toBeLessThanOrEqual(port.bottom + 1);
    expect(bar.getBoundingClientRect().top).toBeGreaterThanOrEqual(port.top - 1);
  });

  it("runs the bar full-bleed, edge to edge of the panel", () => {
    // `-mx-6` exactly cancels the scroller's `px-6`. Asserting the two class
    // literals (as the unit test does) cannot catch one of them changing value
    // while both remain present.
    const { panel, bar } = open();
    const panelRect = panel.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    // Against the panel's CONTENT box, not its border box: the panel carries a
    // 1px border that the bar correctly sits inside. `clientLeft` is exactly
    // that border width, so this stays honest if the border ever changes.
    const contentLeft = panelRect.left + panel.clientLeft;
    expect(Math.abs(barRect.left - contentLeft)).toBeLessThan(1);
    expect(Math.abs(barRect.width - panel.clientWidth)).toBeLessThan(1);
  });

  it("keeps both actions inside the sheet and reachable at a mobile viewport", () => {
    // The failure a guest would report as "I can't press Save": the bar is
    // there, but the button's centre is not what a tap at that point hits.
    const { getByRole } = open();
    for (const name of ["Cancel", "Save"]) {
      const btn = getByRole("button", { name });
      const r = btn.getBoundingClientRect();
      expect(r.width).toBeGreaterThan(0);
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      expect(btn.contains(hit), `${name} is not the topmost element at its own centre`).toBe(true);
    }
  });
});
