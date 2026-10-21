import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { EventSheet } from "../../src/components/EventSheet";
import type { EventSummary } from "../../src/components/types";

/**
 * The venue address in the details sheet's venue row, measured.
 *
 * `MapPreview.test.tsx` pins the *mechanism* — that the address carries no
 * `truncate` and does carry the wrap and clamp utilities. This file pins the
 * *outcome*, and it has to exist because the two are not the same claim:
 *
 *   - Truncation clips **visually** and leaves the text node whole, so
 *     `getByText(address)` passes identically whether the guest sees the suburb
 *     or an ellipsis. jsdom parses no stylesheet and computes no layout, so
 *     nothing in the fast tier can tell those apart.
 *   - The class contract is a statement about source text. It cannot see a
 *     *different* clipping mechanism arriving — an ancestor's `overflow: hidden`,
 *     a `max-height`, or two conflicting utilities resolving by stylesheet order
 *     rather than by class-attribute order.
 *
 * ## Why it renders the event sheet rather than `MapPreview`
 *
 * The width the address gets is decided by a chain that starts outside the
 * component: the dialog's 480px cap, the scrollport's `px-6`, and the key facts'
 * glyph column and gap. Rendering `MapPreview` bare would measure a column no
 * guest ever sees. `DetailsPanel`, inside `EventSheet`, is its only render site.
 *
 * ## Why only the drawn-card branch
 *
 * Both branches render the same address element and the same link; the fast
 * tier pins that. Forcing the iframe branch here would make a real Chromium
 * fetch `www.google.com/maps/embed` on every run of this tier, and a test that
 * needs the network to be up is a test that goes red when it is not.
 *
 * ## The three widths
 *
 * 320 / 768 / 1440. The panel is 480px wide at both 768 and 1440, so those two
 * are not independent layout cases — but they are not identical measurements
 * either, because the type scale is fluid. Every figure below is read off the
 * element at the width under test for that reason; nothing here hard-codes a
 * pixel except the target size, which is a fixed accessibility floor.
 */

// A commonplace Australian address. Two lines in the narrowest column.
const ORDINARY = "Level 3, 45 Wentworth Avenue, Surry Hills NSW 2010";

// Venue, hall, street, suburb, state, postcode, country — the demanding real case.
const FULL = "The Grand Ballroom, Curzon Hall, 53 Agincourt Road, Marsfield NSW 2122, Australia";

// Not an address. `events.address` is free text with no length constraint anywhere.
const UNBOUNDED = `${FULL}, ${FULL}, ${FULL}, ${FULL}`;

const event: EventSummary = {
  id: "event-1",
  name: "Mehndi",
  description: "An evening of henna",
  startAt: "2026-09-18T16:00:00+10:00",
  endAt: "2026-09-18T22:00:00+10:00",
  timezone: "Australia/Sydney",
  address: ORDINARY,
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  sortOrder: 0,
  imageUrl: null,
};

/**
 * Open the sheet at `width` showing `address`, and hand back the venue row's
 * parts, settled.
 *
 * The viewport is set **before** the render, not after: it persists for the rest
 * of the file, and a sheet rendered at the previous width would play its entry
 * transition against a box that is about to change.
 *
 * Then three waits, each for a different reason. A frame, because the entry
 * transition has not started until the initial style has been resolved and
 * `getAnimations()` before that comes back empty. The animations themselves,
 * because `Modal` enters from `translateY(24px) scale(0.98)` and
 * `getBoundingClientRect()` reports the POST-transform box. And
 * `document.fonts.ready`, because Lato is self-hosted and a line count measured
 * against the fallback metrics is a different number.
 */
async function open(width: number, address: string = ORDINARY) {
  await page.viewport(width, 900);

  const view = render(() => (
    <EventSheet
      event={{ ...event, address }}
      panel="details"
      siteUrl="https://invite.test/abc-123"
      members={[]}
      apiUrl="https://api.test"
      onClose={() => {}}
    />
  ));

  const panel = document.querySelector("dialog") as HTMLElement;
  await new Promise(requestAnimationFrame);
  await Promise.allSettled(panel.getAnimations({ subtree: true }).map((a) => a.finished));
  await document.fonts.ready;

  // No build-time embed key under vitest, so this is the drawn-card branch. It
  // is asserted rather than assumed: with a key present the iframe would render
  // instead, and every measurement below would silently be of the other branch.
  expect(document.querySelector("iframe"), "expected the drawn-card branch").toBeNull();

  const addressEl = view.getByText(address);
  const link = view.getByRole("link", { name: "Open in maps" });
  const row = addressEl.closest("dd") as HTMLElement;
  return { address: addressEl, link, row };
}

/** Lines of text actually painted, from the element's own metrics. */
function lineCount(el: HTMLElement): number {
  return el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight);
}

describe.each([320, 768, 1440])("the venue address at %ipx", (width) => {
  afterEach(cleanup);

  it("shows an ordinary address in full", async () => {
    // The assertion that actually means "not truncated". `line-clamp` and
    // `truncate` both work by `overflow: hidden`, so a clipped address is one
    // whose scroll box is bigger than its visible box — in the block axis when
    // it has more lines than the clamp allows, in the inline axis when a long
    // token has nowhere to break.
    const { address } = await open(width, ORDINARY);

    expect(address.scrollHeight).toBeLessThanOrEqual(address.clientHeight + 1);
    expect(address.scrollWidth).toBeLessThanOrEqual(address.clientWidth + 1);
  });

  it("shows a full address, down to its country, in full", async () => {
    // This is what pins the line cap: 81 characters takes three lines in the
    // 238px column at 320px, under the cap of four. If the type scale or the
    // column moves, a real address starts being clipped here and the cap has to
    // be re-decided — which is the failure this asserts.
    const { address } = await open(width, FULL);

    expect(address.scrollHeight).toBeLessThanOrEqual(address.clientHeight + 1);
    expect(address.scrollWidth).toBeLessThanOrEqual(address.clientWidth + 1);
  });

  it("is laid out to wrap rather than to run on one line", async () => {
    // Read from the computed cascade, not from the class attribute: this is the
    // exact declaration `truncate` set, and it is gone whatever route it might
    // have arrived by.
    const { address } = await open(width, ORDINARY);

    expect(getComputedStyle(address).whiteSpace).not.toBe("nowrap");
  });

  it("puts Open in maps under the address, inside the row, at a 44px target", async () => {
    // The link is the row's one action, so it has to be findable under what it
    // opens and big enough for a thumb, and the row must hide nothing sideways.
    const { address, link, row } = await open(width, FULL);

    expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
    const rowBox = row.getBoundingClientRect();
    const linkBox = link.getBoundingClientRect();
    expect(linkBox.top).toBeGreaterThanOrEqual(address.getBoundingClientRect().bottom);
    expect(linkBox.left).toBeGreaterThanOrEqual(rowBox.left - 1);
    expect(linkBox.right).toBeLessThanOrEqual(rowBox.right + 1);
    expect(linkBox.height).toBeGreaterThanOrEqual(44);
  });
});

describe("the venue address in the narrowest column", () => {
  afterEach(cleanup);

  it("genuinely wraps at 320px rather than happening to fit", async () => {
    // Without this the "in full" assertions above pass for the wrong reason: an
    // address on one line is trivially unclipped, and the bug this file exists
    // to catch is about the ones that are not. The column is 238px here — wide
    // enough for a short address on one line, which is why this uses an
    // ordinary one rather than the shortest.
    const { address } = await open(320, ORDINARY);

    expect(lineCount(address)).toBeGreaterThan(1.5);
  });

  it("bounds an address of unlimited length at four lines", async () => {
    // The cap doing the only job left to it. Nothing between the organiser's
    // input and this element constrains the string, so without a cap the row
    // grows without limit and the map and its link sink under a wall of text.
    // A cap that cannot be shown to fire is indistinguishable from one that
    // does nothing, so this fires it.
    const { address } = await open(320, UNBOUNDED);

    expect(lineCount(address)).toBeCloseTo(4, 1);
    expect(address.scrollHeight).toBeGreaterThan(address.clientHeight + 1);
  });
});
