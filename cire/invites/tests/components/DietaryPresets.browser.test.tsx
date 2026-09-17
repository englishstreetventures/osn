import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { RsvpModal } from "../../src/components/RsvpModal";
import type { EventSummary, FamilyMember } from "../../src/components/types";

/*
 * The dietary picker inside the sheet it actually ships in, measured.
 *
 * Two claims live here because nothing below the browser tier can check them.
 *
 * **The track overflows inside the sheet, not the other way round.** A
 * `<fieldset>` resolves its min-width from its content, so sixteen pills will
 * push the whole sheet wider than the phone unless every box between them and
 * the scrollport is allowed to be narrower than what it holds. happy-dom
 * computes no layout and cannot tell the two apart — the classes are identical
 * either way.
 *
 * **The picker stays inline at every width here.** The sheet is a `frame`
 * Modal, whose dialog is `overflow-hidden`. `@shared/ui`'s popover mounts its
 * panel into the open dialog — which is what clears the top layer a
 * `showModal()` dialog occupies — and inside a `frame` dialog that puts it in
 * the clip instead. `RsvpModal` therefore imports `@cire/ui/dietary-presets`,
 * the entry point with no popover in it, rather than the popover shell the host
 * portal uses. This is where that is checked against a real viewport rather than
 * a stubbed `matchMedia`.
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

afterEach(async () => {
  cleanup();
  await page.viewport(...NARROW);
});

/** Mount the sheet and put Priya in the attending state that reveals the picker. */
function openAttending() {
  const utils = render(() => (
    <RsvpModal event={event} members={[priya]} apiUrl="https://api.test" onClose={() => {}} />
  ));
  const fieldset = screen.getByRole("group", { name: /priya sharma/i }) as HTMLElement;
  fireEvent.click(within(fieldset).getByText("Attending"));
  return { ...utils, fieldset };
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
    // `overflow-hidden` and cannot be clicked — see xchromo/osn#1089.
    await page.viewport(...WIDE);
    const { fieldset } = openAttending();
    expect(within(fieldset).getAllByRole("checkbox").length).toBeGreaterThan(0);
    expect(
      within(fieldset).queryByRole("button", { name: /add dietary requirements/i }),
    ).toBeNull();
  });
});
