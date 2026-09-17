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
 *   line ABOVE. This is not hypothetical and it is not a phone: below `sm` both
 *   buttons are `flex-1` and the Respond button is `overflow-hidden`, which
 *   zeroes its automatic minimum size, so a narrow row shrinks rather than
 *   wrapping. What wraps is the DESKTOP card — at `min-width: 1024px` the root
 *   font-size steps 16px → 17px (`src/styles/global.css`), every rem grows at
 *   once, and the two buttons stop fitting the two-column card's text half.
 *
 * Both cases render into `mx-auto max-w-[640px]`, which is the **classic** pack's
 * events-column cap (`designs/classic/InvitePage.tsx`). Gala caps its column at
 * `max-w-[960px]`, leaving its text half roughly half as full again as it needs,
 * so gala has no wrapped case to measure; its DOM order is covered in
 * `tests/designs/gala/InvitePage.test.tsx`.
 */

/** The tester iframe's own default, restored after every test that changes it. */
const DEFAULT: readonly [number, number] = [414, 896];
/** Single-column card, well clear of a wrap: a 590px row against a 271px need. */
const ONE_LINE: readonly [number, number] = [700, 900];
/** Two-column card past the 1024px root-size step: a 272px row against a 286px need. */
const WRAPPED: readonly [number, number] = [1280, 900];

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
function renderCard(withImage: boolean) {
  return render(() => (
    <div class="mx-auto max-w-[640px]">
      <EventCard
        event={withImage ? { ...baseEvent, imageUrl: "/invite/w/event/e/image?v=abc" } : baseEvent}
        apiUrl={withImage ? "/api" : undefined}
        onRespond={noop}
        onDetails={noop}
      />
    </div>
  ));
}

/** The two action buttons and the row that holds them, as painted. */
function actions(container: HTMLElement) {
  const buttons = [...container.querySelectorAll("button")];
  const details = buttons.find((b) => b.textContent === "Event Details")!;
  const respond = buttons.find((b) => b.textContent === "Respond")!;
  return {
    details: details.getBoundingClientRect(),
    respond: respond.getBoundingClientRect(),
    rowWidth: Math.round(details.parentElement!.getBoundingClientRect().width),
  };
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
