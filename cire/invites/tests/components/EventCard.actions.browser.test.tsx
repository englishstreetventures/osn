import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { EventCard } from "../../src/components/EventCard";
import type { EventSummary } from "../../src/components/types";

/*
 * Which of the card's two actions a guest reads first, MEASURED.
 *
 * `EventCard.test.tsx` asserts the DOM order, which is the mechanism: the pair
 * carries no `order-*` class, so the flex row paints in DOM order. It cannot
 * assert the outcome — happy-dom computes no layout and returns all zeroes from
 * `getBoundingClientRect` — and the outcome is the thing a guest has. A single
 * `order-1` anywhere in the cascade would invert the painted row with every
 * class-presence test still green.
 *
 * Two widths, because a flex row has two shapes and only one of them is the
 * obvious one:
 *
 * - **One line.** The row lays out left to right, so "Event Details" must be the
 *   left-hand button.
 * - **Wrapped.** The row breaks onto two lines, so "Event Details" must be the
 *   line ABOVE. Two different widths reach that shape. The DESKTOP card does at
 *   `min-width: 1024px`, where the root font-size steps 16px → 17px
 *   (`src/styles/global.css`), every rem grows at once, and the two buttons stop
 *   fitting the two-column card's text half. A 320px phone does too: below `sm`
 *   both buttons are `flex-1`, and each keeps the automatic minimum size of its
 *   own label, so the row breaks rather than squeezing either one.
 *
 * The third case below measures that phone, because the Respond button clips its
 * own label the moment it is allowed to shrink past the word.
 *
 * Every case renders into the events section's own `px-6` and `mx-auto
 * max-w-column-xl`, which is the **classic** pack's events-column cap
 * (`designs/classic/InvitePage.tsx`). That token is 640 real pixels, and it has
 * to be: the wrapped case below lives past the 1024px root-size step, so a cap
 * on the rem-based spacing scale would be 680px there and the row would stop
 * wrapping. Gala caps its column at `max-w-column-2xl`, leaving its text half
 * roughly half as full again as it needs, so gala has no wrapped case to
 * measure; its DOM order is covered in
 * `tests/designs/gala/InvitePage.test.tsx`.
 */

/** The tester iframe's own default, restored after every test that changes it. */
const DEFAULT: readonly [number, number] = [414, 896];
/** Single-column card, well clear of a wrap: a 590px row against a 271px need. */
const ONE_LINE: readonly [number, number] = [700, 900];
/** Two-column card past the 1024px root-size step: a 272px row against a 286px need. */
const WRAPPED: readonly [number, number] = [1280, 900];
/** WCAG 2.2 Reflow's floor (1.4.10), and the width an iPhone SE reports. */
const REFLOW: readonly [number, number] = [320, 900];

const baseEvent: EventSummary = {
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

/**
 * The card in classic's events column.
 *
 * `withImage` is what puts the card into its two-column `md:grid-cols-2` shape,
 * which is the only shape whose text half is narrow enough to wrap the row. The
 * image is **not expected to load** — `/api` is a relative origin, so the request
 * is same-origin against the test server and 404s there instead of costing a DNS
 * lookup for a host that does not exist. Nothing measured here depends on it: the
 * grid's columns are `minmax(0, 1fr)`, so they are sized by the card, not by the
 * picture.
 */
function renderCard(withImage: boolean, rsvpClosed = false) {
  return render(() => (
    // `px-6` is the events section's own mobile padding
    // (`designs/classic/InvitePage.tsx`), which is what decides how much width
    // the card has at 320px. Harmless at the two wider cases, where the column
    // cap binds first.
    <div class="px-6">
      <div class="max-w-column-xl mx-auto">
        <EventCard
          event={
            withImage ? { ...baseEvent, imageUrl: "/invite/w/event/e/image?v=abc" } : baseEvent
          }
          apiUrl={withImage ? "/api" : undefined}
          onRespond={noop}
          onDetails={noop}
          rsvpClosed={rsvpClosed}
          rsvpClosedNoticeId={rsvpClosed ? "rsvp-notice" : undefined}
        />
      </div>
    </div>
  ));
}

/** The two action buttons and the row that holds them, as painted. */
function actions(container: HTMLElement) {
  const buttons = [...container.querySelectorAll("button")];
  const details = buttons.find((b) => b.textContent === "Event Details")!;
  // By elimination rather than by label: the answer button reads "Respond" open
  // and "RSVPs closed" shut, and both are measured here.
  const respond = buttons.find((b) => b !== details)!;
  return {
    respondEl: respond,
    details: details.getBoundingClientRect(),
    respond: respond.getBoundingClientRect(),
    rowWidth: Math.round(details.parentElement!.getBoundingClientRect().width),
  };
}

/**
 * The answer button's label box — the `relative` span holding the word and, once
 * a reply is on file, the tick. It is a block-level flex box filling the
 * button's content width, so the word overflowing it is exactly the clipping a
 * guest sees.
 */
function label(respond: HTMLElement) {
  return respond.querySelector("span.relative") as HTMLElement;
}

afterEach(async () => {
  cleanup();
  await page.viewport(...DEFAULT);
});

describe("the event card's two actions, as painted", () => {
  it("puts Event Details on the left when they share a line", async () => {
    await page.viewport(...ONE_LINE);
    const { container } = renderCard(false);
    // The invite's faces are self-hosted, and a width taken against fallback
    // metrics is a different number.
    await document.fonts.ready;

    const { details, respond, rowWidth } = actions(container);
    // Asserted before the order so an unexpected wrap fails on its cause rather
    // than as a confusing "these two numbers differ".
    expect(details.top, `the row wrapped at ${rowWidth}px — this case wants one line`).toBe(
      respond.top,
    );
    expect(details.right).toBeLessThanOrEqual(respond.left);
  });

  it("puts Event Details on the line above when the row wraps", async () => {
    await page.viewport(...WRAPPED);
    const { container } = renderCard(true);
    await document.fonts.ready;

    const { details, respond, rowWidth } = actions(container);
    // Same reason, the other way round: if the row ever stops wrapping here this
    // test must say so rather than quietly re-testing the case above.
    expect(
      details.top,
      `the row no longer wraps at ${rowWidth}px — this case wants two lines`,
    ).not.toBe(respond.top);
    expect(details.bottom).toBeLessThanOrEqual(respond.top);
  });
});

/*
 * The narrowest width the invite promises, MEASURED.
 *
 * The answer button clips: it carries a clipping `overflow` for the confirmation
 * fill that sweeps across it, and "Event Details" carries `whitespace-nowrap`,
 * so whichever way the free space is short the answer button is the one that
 * absorbs it. Its own automatic minimum size is the only thing standing between
 * the guest and a half-word — and a scroll container's automatic minimum size is
 * zero, which is why `overflow-clip` and `overflow-hidden` are not
 * interchangeable here even though they clip to the same rounded box.
 *
 * Both labels are measured, and the harder of the two is not the one it looks
 * like. "RSVPs closed" is the longer line, but it holds a space and so breaks;
 * "Respond" is one unbreakable word, so it is the larger automatic minimum and
 * the case that decides whether the row fits. Neither may clip — the closed
 * label is what a guest arriving after the deadline reads.
 */
describe("the answer button at the Reflow floor", () => {
  it.each([
    { name: "Respond", closed: false },
    { name: "RSVPs closed", closed: true },
  ])("shows the whole of $name at 320px inside the section's padding", async ({ closed }) => {
    await page.viewport(...REFLOW);
    const { container } = renderCard(false, closed);
    // The invite's faces are self-hosted, and a width taken against fallback
    // metrics is a different number.
    await document.fonts.ready;

    const { respondEl, respond, rowWidth } = actions(container);
    const text = label(respondEl);

    expect(
      text.scrollWidth,
      `"${text.textContent}" overflows its ${Math.round(text.clientWidth)}px label box — button ${Math.round(respond.width)}px in a ${rowWidth}px row`,
    ).toBeLessThanOrEqual(text.clientWidth);
  });

  it("still clips the confirmation fill to the button's rounded box", async () => {
    await page.viewport(...REFLOW);
    const { container } = renderCard(false);
    await document.fonts.ready;

    const { respondEl } = actions(container);
    const style = getComputedStyle(respondEl);

    // `clip` rather than `hidden`: it clips the fill to the same rounded box
    // without making the button a scroll container, which is what leaves the
    // automatic minimum size above intact.
    expect(style.overflow).toBe("clip");
    expect(style.borderRadius).not.toBe("0px");
  });
});
