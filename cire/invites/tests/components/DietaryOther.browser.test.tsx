import { cleanup, fireEvent, render, screen, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../src/styles/global.css";
import { RsvpModal } from "../../src/components/RsvpModal";
import type { EventSummary, FamilyMember, RsvpSummary } from "../../src/components/types";

/*
 * The "Anything else" field's reveal, measured.
 *
 * Ticking "Other" adds a field to a sheet the guest is already reading, and a
 * box that appears between two frames shoves everything under it with no
 * explanation. `Reveal` opens it on a `grid-template-rows` transition instead.
 *
 * Nothing below this tier can see any of that: happy-dom runs no transitions
 * and computes no layout, so it cannot tell an animated open from an instant
 * one, and `getAnimations()` there is always empty.
 *
 * The second test is the one that is easy to lose. A reply that already carries
 * dietary prose opens the field at mount, and a reveal that ran there would
 * animate a field in behind the sheet's own entry — motion for a state that was
 * never entered. It does not run, because the wrapper mounts already open and a
 * transition needs a state to start from.
 */

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

function mount(existingRsvps?: readonly RsvpSummary[]) {
  const utils = render(() => (
    <RsvpModal
      event={event}
      members={[priya]}
      existingRsvps={existingRsvps}
      apiUrl="https://api.test"
      onClose={() => {}}
    />
  ));
  const fieldset = screen.getByRole("group", { name: /priya sharma/i }) as HTMLElement;
  return { ...utils, fieldset };
}

/** The `Reveal` wrapper around the free-text field: the grid whose rows move. */
function trackOf(fieldset: HTMLElement): HTMLElement {
  const label = within(fieldset).getByText(/anything else/i);
  const wrapper = label.closest("div.grid");
  if (!wrapper) throw new Error("no Reveal wrapper around the Anything else field");
  return wrapper as HTMLElement;
}

async function settle() {
  await new Promise(requestAnimationFrame);
  const panel = document.querySelector("dialog") as HTMLElement;
  await Promise.allSettled(panel.getAnimations({ subtree: true }).map((a) => a.finished));
}

describe("the Anything else field", () => {
  it("opens on a transition when Other is ticked", async () => {
    await page.viewport(...NARROW);
    const { fieldset } = mount();
    fireEvent.click(within(fieldset).getByText("Attending"));
    await settle();

    expect(within(fieldset).queryByText(/anything else/i)).toBeNull();

    (within(fieldset).getByText("Other").closest("label") as HTMLElement).click();
    await new Promise(requestAnimationFrame);

    const track = trackOf(fieldset);
    const running = track.getAnimations();
    // A transition is running, and it is the row track that is moving — an
    // opacity-only fade would satisfy a bare `length > 0` while the field still
    // snapped to full height.
    expect(running.length).toBeGreaterThan(0);
    expect(
      running.some((a) => (a as CSSTransition).transitionProperty === "grid-template-rows"),
    ).toBe(true);
    // Mid-transition the box is open but not yet fully open.
    const midway = track.getBoundingClientRect().height;

    await Promise.allSettled(running.map((a) => a.finished));
    const open = track.getBoundingClientRect().height;
    expect(open).toBeGreaterThan(midway);
    expect(within(fieldset).getByPlaceholderText(/no onion/i)).toBeTruthy();
  });

  it("clips the collapsing box on both axes, so it is not a scroll container", async () => {
    // The same argument `Modal`'s frame panel makes one level up. `Reveal`
    // wraps form fields; regressed to `overflow: hidden` the box would still be
    // a scroll container holding a focusable input, and `scrollIntoView` or a
    // focus landing inside it would scroll content the guest cannot scroll
    // back. Both axes have to read `clip` — beside an `auto` axis a `clip`
    // computes to `hidden` (CSS Overflow 3 §3.1) and the guard would pass while
    // the box stayed scrollable.
    await page.viewport(...NARROW);
    const { fieldset } = mount();
    fireEvent.click(within(fieldset).getByText("Attending"));
    await settle();
    (within(fieldset).getByText("Other").closest("label") as HTMLElement).click();
    await new Promise(requestAnimationFrame);

    const inner = trackOf(fieldset).firstElementChild as HTMLElement;
    const style = window.getComputedStyle(inner);
    expect([style.overflowX, style.overflowY]).toEqual(["clip", "clip"]);
  });

  it("is simply open, with no animation, for a reply that already has prose", async () => {
    await page.viewport(...NARROW);
    const { fieldset } = mount([
      {
        guestId: priya.guestId,
        eventId: event.id,
        status: "attending",
        dietary: "no onion or garlic",
        dietaryPresets: [],
        dietaryConsentCurrent: true,
      },
    ]);
    await new Promise(requestAnimationFrame);

    const track = trackOf(fieldset);
    expect(
      track
        .getAnimations()
        .some((a) => (a as CSSTransition).transitionProperty === "grid-template-rows"),
    ).toBe(false);
    expect(track.getBoundingClientRect().height).toBeGreaterThan(0);
    expect((within(fieldset).getByPlaceholderText(/no onion/i) as HTMLInputElement).value).toBe(
      "no onion or garlic",
    );
  });

  it("removes the field at once when Other is unticked", async () => {
    // No exit transition, on purpose: holding the content in the document while
    // the box collapses leaves a focusable input inside a box of zero height,
    // which a keyboard reaches and an eye does not.
    await page.viewport(...NARROW);
    const { fieldset } = mount();
    fireEvent.click(within(fieldset).getByText("Attending"));
    await settle();

    const other = within(fieldset).getByText("Other").closest("label") as HTMLElement;
    other.click();
    await new Promise(requestAnimationFrame);
    expect(within(fieldset).queryByPlaceholderText(/no onion/i)).toBeTruthy();

    other.click();
    await new Promise(requestAnimationFrame);
    expect(within(fieldset).queryByPlaceholderText(/no onion/i)).toBeNull();
  });
});
