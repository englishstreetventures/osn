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
 * - **One line.** The row lays out left to right, so "Event details" must be the
 *   left-hand button.
 * - **Wrapped.** The row breaks onto two lines, so "Event details" must be the
 *   line ABOVE. A 320px phone with a reply on file reaches that shape, its
 *   answer button reading "RSVP given" beside the tick: below `sm` both buttons
 *   are `flex-1`, and each keeps the automatic minimum size of its own label, so
 *   the row breaks rather than squeezing either one. "Respond" alone is short
 *   enough to share the 320px row. The desktop card's two-column text half
 *   holds "Event details" and "Respond" on one line at every width, past the
 *   1024px root-size step included.
 *
 * The Reflow cases below measure that phone as well, because the Respond button
 * clips its own label the moment it is allowed to shrink past the word.
 *
 * Every case renders into the events section's own `px-6` and `mx-auto
 * max-w-column-xl`, which is the **classic** pack's events-column cap
 * (`designs/classic/InvitePage.tsx`). Gala's DOM order is covered in
 * `tests/designs/gala/InvitePage.test.tsx`.
 */

/** The tester iframe's own default, restored after every test that changes it. */
const DEFAULT: readonly [number, number] = [414, 896];
/**
 * Single-column card, well clear of a wrap: a 590px row against a 220px need
 * (the two buttons' own widths, 115.9px and 92.2px, and the 12px gap).
 */
const ONE_LINE: readonly [number, number] = [700, 900];
/**
 * A phone at the Reflow floor, with a reply on file: a 222px row against a 260px
 * need ("Event details" 115.9px, "RSVP given" and its tick 131.7px, the gap).
 */
const WRAPPED: readonly [number, number] = [320, 900];
/** Two-column card: a 272px text-half row against a 233px need (123.1 + 97.8 + 12 gap). */
const DESKTOP: readonly [number, number] = [1280, 900];
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
function renderCard(withImage: boolean, rsvpClosed = false, responded = false) {
  return render(() => (
    // `px-6` is the events section's own mobile padding
    // (`designs/classic/InvitePage.tsx`), which is what decides how much width
    // the card has at 320px. Harmless at 700px, where the column cap binds
    // first.
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
          responded={responded}
        />
      </div>
    </div>
  ));
}

/** The two action buttons and the row that holds them, as painted. */
function actions(container: HTMLElement) {
  const buttons = [...container.querySelectorAll("button")];
  const details = buttons.find((b) => b.textContent === "Event details")!;
  // By elimination rather than by label: the answer button reads "Respond"
  // before a reply and "RSVP given" after one, and both are measured here.
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
  it("puts Event details on the left when they share a line", async () => {
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

  it("puts Event details on the left when they share a line, in the two-column desktop card", async () => {
    await page.viewport(...DESKTOP);
    const { container } = renderCard(true);
    await document.fonts.ready;

    const { details, respond, rowWidth } = actions(container);
    expect(details.top, `the row wrapped at ${rowWidth}px — this case wants one line`).toBe(
      respond.top,
    );
    expect(details.right).toBeLessThanOrEqual(respond.left);
  });

  it("puts Event details on the line above when the row wraps", async () => {
    await page.viewport(...WRAPPED);
    const { container } = renderCard(false, false, true);
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
 * fill that sweeps across it, and "Event details" carries `whitespace-nowrap`,
 * so whichever way the free space is short the answer button is the one that
 * absorbs it. Its own automatic minimum size is the only thing standing between
 * the guest and a half-word — and a scroll container's automatic minimum size is
 * zero, which is why `overflow-clip` and `overflow-hidden` are not
 * interchangeable here even though they clip to the same rounded box.
 *
 * Both labels are measured. "RSVP given" is the longer line and carries the
 * tick beside it, but it holds a space and so breaks; "Respond" is one
 * unbreakable word. Neither may clip — "RSVP given" past the deadline is how a
 * guest gets back to their reply.
 */
describe("the answer button at the Reflow floor", () => {
  it.each([
    { name: "Respond", closed: false, responded: false },
    { name: "RSVP given", closed: true, responded: true },
  ])(
    "shows the whole of $name at 320px inside the section's padding",
    async ({ closed, responded }) => {
      await page.viewport(...REFLOW);
      const { container } = renderCard(false, closed, responded);
      // The invite's faces are self-hosted, and a width taken against fallback
      // metrics is a different number.
      await document.fonts.ready;

      const { respondEl, respond, rowWidth } = actions(container);
      const text = label(respondEl);

      expect(
        text.scrollWidth,
        `"${text.textContent}" overflows its ${Math.round(text.clientWidth)}px label box — button ${Math.round(respond.width)}px in a ${rowWidth}px row`,
      ).toBeLessThanOrEqual(text.clientWidth);
    },
  );

  it("keeps the RSVPs-closed badge inside the card beside a long event name at 320px", async () => {
    await page.viewport(...REFLOW);
    const { container } = render(() => (
      <div class="px-6">
        <div class="max-w-column-xl mx-auto">
          <EventCard
            event={{ ...baseEvent, name: "Sangeet and Garba Night" }}
            onRespond={noop}
            onDetails={noop}
            rsvpClosed
            rsvpClosedNoticeId="rsvp-notice"
            responded
          />
        </div>
      </div>
    ));
    await document.fonts.ready;

    const article = container.querySelector("article")!.getBoundingClientRect();
    const badge = [...container.querySelectorAll("span")]
      .find((s) => s.textContent === "RSVPs closed")!
      .getBoundingClientRect();
    // The row wraps the badge under the name rather than pushing it past the
    // card's edge.
    expect(badge.right).toBeLessThanOrEqual(article.right);
    expect(badge.left).toBeGreaterThanOrEqual(article.left);
    expect(badge.width).toBeGreaterThan(0);
    // `whitespace-nowrap`: the badge never breaks its own two words.
    expect(badge.height).toBeLessThan(30);
  });

  // The organiser writes the venue name and the description, and nothing
  // between their input and here gives a long word somewhere to break: a
  // pasted link, or a venue named in one token.
  it("keeps the answer button inside the card beside a link in the description and a one-word venue", async () => {
    await page.viewport(390, 900);
    const { container } = render(() => (
      <div class="px-6">
        <div class="max-w-column-xl mx-auto">
          <EventCard
            event={{
              ...baseEvent,
              venueName: "Thegrandoldboathousebytheharbourfrontmarina",
              description:
                "Shuttle times: https://maps.app.goo.gl/q4Zt9XaBcDeFgHiJkLmNoPqRsTuVwXyZ12345",
            }}
            onRespond={noop}
            onDetails={noop}
          />
        </div>
      </div>
    ));
    await document.fonts.ready;

    const article = container.querySelector("article")!.getBoundingClientRect();
    const { respond } = actions(container);
    expect(respond.right).toBeLessThanOrEqual(article.right);
    for (const p of container.querySelectorAll("p")) {
      expect({ text: p.textContent, fits: p.scrollWidth <= p.clientWidth }).toMatchObject({
        fits: true,
      });
    }
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
