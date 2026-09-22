import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { RsvpModal } from "../../src/components/RsvpModal";
import type { EventSummary, FamilyMember } from "../../src/components/types";

/*
 * The dietary picker inside the sheet it actually ships in, measured.
 *
 * Four claims live here because nothing below the browser tier can check them.
 *
 * **The track overflows inside the sheet, not the other way round.** A
 * `<fieldset>` resolves its min-width from its content, so sixteen pills will
 * push the whole sheet wider than the phone unless every box between them and
 * the scrollport is allowed to be narrower than what it holds. happy-dom
 * computes no layout and cannot tell the two apart — the classes are identical
 * either way.
 *
 * **The picker stays inline at every width here.** The sheet is a `frame`
 * Modal, whose dialog is `overflow-clip`. `@shared/ui`'s popover mounts its
 * panel into the open dialog — which is what clears the top layer a
 * `showModal()` dialog occupies — and inside a `frame` dialog that puts it in
 * the clip instead. `RsvpModal` therefore imports `@cire/ui/dietary-presets`,
 * the entry point with no popover in it, rather than the popover shell the host
 * portal uses. This is where that is checked against a real viewport rather than
 * a stubbed `matchMedia`.
 *
 * **Ticking a pill does not move the sheet.** Each pill hides a real checkbox
 * behind `sr-only`, which is `position: absolute` — so unless the pill itself
 * is a containing block, that input resolves against whatever box is positioned
 * further up and does not travel with the track's sideways scroll. Focusing it
 * then asks the browser to scroll toward a position hundreds of pixels outside
 * the sheet, and the browser obliges by scrolling the `<dialog>`. Measured on
 * the parent of this commit: `dialog.scrollLeft` went 0 → 1213 at 1024px and
 * 0 → 1182 at 414px, and never came back.
 *
 * **The close chip stays on top.** Making each pill `position: relative` is
 * what fixes the above, and it also promotes sixteen boxes past the chip, which
 * is an earlier-in-tree positioned sibling of the scroller with nothing but
 * tree order holding it up. Only a hit test can see that.
 */

/** Wide enough to clear the picker's 48rem query with room to spare. */
const WIDE: readonly [number, number] = [1024, 900];
/** The tester iframe's own default, restored after any test that widens it. */
const NARROW: readonly [number, number] = [414, 896];

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

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  nickname: null,
  eventIds: ["event-1"],
};

/**
 * Priya and seven more.
 *
 * The close-chip test has to scroll a pill up under the chip, and a sheet only
 * scrolls as far as it is long. One guest leaves 124px of travel at 414x896 and
 * the picker never reaches the chip, so the hit test would pass against a
 * geometry where the two boxes never meet.
 */
const household: FamilyMember[] = [
  priya,
  ...["Ravi", "Anita", "Dev", "Meera", "Arjun", "Kavya", "Rohit"].map((firstName, i) => ({
    guestId: `guest-${i}`,
    firstName,
    lastName: "Sharma",
    nickname: null,
    eventIds: ["event-1"],
  })),
];

afterEach(async () => {
  cleanup();
  await page.viewport(...NARROW);
});

/**
 * Mount the sheet and put Priya in the attending state that reveals the picker.
 *
 * `members` is the whole household where a test needs the sheet to be long
 * enough to scroll; only Priya's fieldset is handed back either way.
 */
function openAttending(members: readonly FamilyMember[] = [priya]) {
  const utils = render(() => (
    <RsvpModal event={event} members={members} apiUrl="https://api.test" onClose={() => {}} />
  ));
  const fieldset = screen.getByRole("group", { name: /priya sharma/i }) as HTMLElement;
  fireEvent.click(within(fieldset).getByText("Attending"));
  return { ...utils, fieldset };
}

/**
 * Let the sheet's entry finish.
 *
 * `Modal` enters from `translateY(24px) scale(0.98)`, and a frame asked for
 * before the initial style has resolved reports no animations at all — so the
 * frame comes first and the animations after it.
 */
async function settle() {
  await new Promise(requestAnimationFrame);
  const panel = document.querySelector("dialog") as HTMLElement;
  await Promise.allSettled(panel.getAnimations({ subtree: true }).map((a) => a.finished));
}

/** Scroll the pill track to its far end, the way a guest reaching "Other" does. */
async function scrollTrackToEnd(fieldset: HTMLElement) {
  const group = within(fieldset).getByRole("group", { name: /dietary requirements/i });
  const track = group.firstElementChild as HTMLElement;
  track.scrollLeft = track.scrollWidth;
  await new Promise(requestAnimationFrame);
  // The guard is worthless against a track that never scrolled.
  expect(track.scrollLeft).toBeGreaterThan(0);
  return track;
}

describe("dietary picker, in the sheet", () => {
  it("shows the presets inline on a phone, with no control to open first", async () => {
    // The real query, at the iframe's own width. Answering is a tap, and a
    // control you must open before you can start is a tap spent on nothing.
    await page.viewport(...NARROW);
    const { fieldset } = openAttending();
    expect(within(fieldset).getAllByRole("checkbox").length).toBeGreaterThan(0);
    expect(
      within(fieldset).queryByRole("button", { name: /add dietary requirements/i }),
    ).toBeNull();
  });

  it("scrolls the preset track sideways without moving the sheet", async () => {
    await page.viewport(...NARROW);
    const { fieldset } = openAttending();
    const group = within(fieldset).getByRole("group", { name: /dietary requirements/i });
    const track = group.firstElementChild as HTMLElement;
    // Sixteen pills do not fit 414px, so the track must be the thing that
    // overflows — if it is not scrollable the tail is simply unreachable. And
    // the overflow must stay INSIDE it: a `<fieldset>` sizes to its content
    // unless told otherwise, and without `min-w-0` the pills push the whole
    // sheet wider than the phone instead.
    expect(track.scrollWidth).toBeGreaterThan(track.clientWidth);
    expect(group.clientWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  it("stays inline on a desktop viewport, because the sheet is a `frame` modal", async () => {
    // Not the entry point the host portal imports. Rendering the trigger here
    // would ship a control whose panel opens inside the dialog's
    // `overflow-clip` and cannot be clicked — see xchromo/osn#1089.
    await page.viewport(...WIDE);
    const { fieldset } = openAttending();
    expect(within(fieldset).getAllByRole("checkbox").length).toBeGreaterThan(0);
    expect(
      within(fieldset).queryByRole("button", { name: /add dietary requirements/i }),
    ).toBeNull();
  });
});

describe("ticking a pill after scrolling the track", () => {
  for (const [name, size] of [
    ["desktop", WIDE],
    ["phone", NARROW],
  ] as const) {
    it(`leaves the sheet where it was, on ${name}`, async () => {
      await page.viewport(...size);
      const { fieldset } = openAttending();
      await settle();
      await scrollTrackToEnd(fieldset);

      const dialog = document.querySelector("dialog") as HTMLElement;
      const boxes = within(fieldset).getAllByRole("checkbox") as HTMLInputElement[];
      const last = boxes[boxes.length - 1] as HTMLInputElement;
      (last.closest("label") as HTMLElement).click();
      await new Promise(requestAnimationFrame);

      // The tick itself must still work — a guard that passes because nothing
      // happened is not a guard.
      expect(last.checked).toBe(true);

      // The cause, and the only assertion here that can tell you it came back:
      // the hidden input must resolve inside its own pill, so that it travels
      // with the track and focusing it asks for a scroll of zero.
      expect(last.offsetParent).toBe(last.closest("label"));

      // The symptom. `dialog.scrollLeft` cannot fail on its own — the frame
      // panel is `overflow: clip`, so no scroll offset exists for it to hold,
      // and that contract is guarded where it lives, in
      // `shared/ui/tests/modal.browser.test.tsx`. The scrollport is the box
      // that genuinely could move: `overflow-y-auto` leaves its x axis
      // computing to `auto`, so it is horizontally scrollable.
      expect(dialog.scrollLeft).toBe(0);
      expect((document.querySelector("dialog [tabindex='0']") as HTMLElement).scrollLeft).toBe(0);
    });
  }
});

describe("the close chip", () => {
  for (const [name, size] of [
    ["desktop", WIDE],
    ["phone", NARROW],
  ] as const) {
    it(`stays above a pill scrolled under it, on ${name}`, async () => {
      // Positioning the pills is what fixes the slide, and it costs this: a
      // pill is now a positioned box later in the tree than the close chip,
      // which had nothing but tree order holding it up. The chip carries an
      // explicit `z-index` for that reason, and this is what would notice if
      // it were dropped. Measured with it removed: `elementFromPoint` at the
      // chip's left edge answers the pill's `<label>`.
      //
      // The overlap is small and real — the track's right edge sits a few
      // pixels inside the chip's left one — so the probe point is computed
      // from the intersection rather than guessed, and the intersection is
      // asserted before it is used. A hit test run where the two boxes do not
      // actually meet passes whatever the z-index says.
      await page.viewport(...size);
      const { fieldset } = openAttending(household);
      await settle();
      await scrollTrackToEnd(fieldset);

      const chip = screen.getByRole("button", { name: /close/i });
      const pill = (within(fieldset).getAllByRole("checkbox").at(-1) as HTMLElement).closest(
        "label",
      ) as HTMLElement;
      const scrollport = document.querySelector("dialog [tabindex='0']") as HTMLElement;

      // Scroll the sheet until that pill's band covers the chip's. The sheet
      // has to be long enough to do it, which is why this mounts a household
      // rather than one guest.
      scrollport.scrollTop += pill.getBoundingClientRect().top - chip.getBoundingClientRect().top;
      await new Promise(requestAnimationFrame);

      const c = chip.getBoundingClientRect();
      const p = pill.getBoundingClientRect();
      const overlap = {
        left: Math.max(c.left, p.left),
        right: Math.min(c.right, p.right),
        top: Math.max(c.top, p.top),
        bottom: Math.min(c.bottom, p.bottom),
      };
      expect(overlap.right, "the pill and the chip must actually meet").toBeGreaterThan(
        overlap.left,
      );
      expect(overlap.bottom, "the pill and the chip must actually meet").toBeGreaterThan(
        overlap.top,
      );

      const hit = document.elementFromPoint(
        (overlap.left + overlap.right) / 2,
        (overlap.top + overlap.bottom) / 2,
      );
      expect(chip.contains(hit)).toBe(true);
    });
  }
});
