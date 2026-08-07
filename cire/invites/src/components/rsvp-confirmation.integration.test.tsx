import { render, cleanup, fireEvent, within } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { describe, it, expect, vi, afterEach } from "vitest";

import { EventCard } from "./EventCard";
import { hasHouseholdResponded, TOTAL_DURATION_MS } from "./rsvp-responded";
import { SAVED_DWELL_MS } from "./rsvp-saved";
import { RsvpModal } from "./RsvpModal";
import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

/**
 * The seam between `RsvpModal` and `EventCard`, owned by one test.
 *
 * Both components are individually well covered, and that is exactly how the
 * bug this file exists for shipped green: `RsvpModal`'s tests know nothing of
 * `EventCard`, and both `InvitePage` packs mock `RsvpModal` and invoke
 * `onConfirmed` by hand — so the sheet in those tests is a stub that never
 * closes, and the celebration is asserted while it is still mounted. Each side
 * was correct against a contract that was jointly wrong: the cue fired at
 * reply-record time, and the whole 1400ms choreography played under a sheet
 * that stayed up for its first 900ms.
 *
 * The property that was actually violated is a relationship between two
 * components across a timer, so only a test holding both can state it:
 * **when the fill turns on, the sheet is no longer over the button.**
 *
 * That statement is what makes this more than a duplicate of the two sides. It
 * fails on a straight revert of the fix, and it also fails on a subtler change
 * neither side can see — `RsvpModal` self-closes by calling `props.onClose()`
 * directly (`RsvpModal.tsx`), deliberately bypassing `AnimatedModal`'s
 * `handleClose` and its awaited 200ms `modalExit`. Routing the self-close
 * through the animated path would look like polish and would put the sweep-in
 * back under a fading panel, with every other test in the repo still passing.
 */

vi.mock("motion", () => ({
  animate: vi.fn(() => ({ finished: Promise.resolve() })),
}));

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
};

const priya: FamilyMember = {
  guestId: "guest-priya",
  firstName: "Priya",
  lastName: "Sharma",
  eventIds: ["event-1"],
};

const savedRow: RsvpSummary = {
  guestId: "guest-priya",
  eventId: "event-1",
  status: "attending",
  dietary: "",
};

/** The Respond button on the card — the control the confirmation plays on. */
function respondButton(): HTMLButtonElement {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Respond" || b.textContent === "RSVPs closed",
  ) as HTMLButtonElement;
}

/** The absolutely-positioned fill layer inside Respond; `scale-x-100` = swept in. */
function fillIsUp(): boolean {
  const fill = respondButton().querySelector("span[aria-hidden='true']");
  return (fill?.className ?? "").includes("scale-x-100");
}

/** The sheet, by the role `AnimatedModal` gives it. Null once it has closed. */
function sheet(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function fieldsetFor(name: string): HTMLElement {
  for (const l of document.querySelectorAll("legend")) {
    if ((l.textContent ?? "").includes(name)) return l.closest("fieldset") as HTMLElement;
  }
  throw new Error(`fieldset for ${name} not found`);
}

/**
 * Reproduces `InvitePage`'s wiring around the two real components without
 * `InvitePage` itself — whose test files carry a module-level `vi.mock` of
 * `RsvpModal` that would defeat the entire point of this file.
 */
function Harness() {
  const [open, setOpen] = createSignal(false);
  const [justResponded, setJustResponded] = createSignal(false);
  const [rsvps, setRsvps] = createSignal<RsvpSummary[]>([]);

  return (
    <>
      <EventCard
        event={event}
        responded={hasHouseholdResponded(event, [priya], rsvps())}
        justResponded={justResponded()}
        onCelebrated={() => setJustResponded(false)}
        onRespond={() => setOpen(true)}
        onDetails={() => {}}
      />
      <Show when={open()}>
        <RsvpModal
          event={event}
          members={[priya]}
          apiUrl="https://api.test"
          onClose={() => setOpen(false)}
          onSubmitted={(updated: RsvpSummary[]) => setRsvps(updated)}
          onConfirmed={() => setJustResponded(true)}
        />
      </Show>
    </>
  );
}

/** Open the sheet, answer for Priya, submit. Leaves the clock mid-dwell. */
async function submit() {
  fireEvent.click(respondButton());
  await vi.advanceTimersByTimeAsync(0);
  fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
  fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);
  await vi.advanceTimersByTimeAsync(0);
}

describe("RSVP confirmation — RsvpModal ↔ EventCard", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubOkFetch() {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ rsvps: [savedRow] }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
  }

  it("never sweeps the fill while the sheet is still over the button", async () => {
    stubOkFetch();
    vi.useFakeTimers();
    render(() => <Harness />);
    await submit();

    // Mid-dwell: the reply is recorded and the sheet says so, but it is still
    // covering the card. Nothing may have started animating underneath it.
    expect(sheet()).toBeTruthy();
    expect(document.querySelector("button[type='submit']")!.textContent).toContain("Saved");
    expect(fillIsUp()).toBe(false);
  });

  it("turns the fill on in the same pass the sheet leaves the DOM", async () => {
    stubOkFetch();
    vi.useFakeTimers();
    render(() => <Harness />);
    await submit();

    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);

    // The joint statement neither component's own tests can make. Asserted in
    // one pass on purpose: "sheet gone" and "fill up" being true at the same
    // observation is the whole contract, and either alone is satisfiable by the
    // buggy ordering.
    expect(sheet()).toBeNull();
    expect(fillIsUp()).toBe(true);

    // And the tick is being DRAWN at that moment, not already settled.
    const path = respondButton().querySelector("svg path") as SVGPathElement;
    expect(path.getAttribute("class")).toContain("animate-tick-draw");
  });

  it("settles to a permanent tick with the fill gone once the celebration ends", async () => {
    stubOkFetch();
    vi.useFakeTimers();
    render(() => <Harness />);
    await submit();
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
    await vi.advanceTimersByTimeAsync(TOTAL_DURATION_MS);

    expect(fillIsUp()).toBe(false);
    const path = respondButton().querySelector("svg path") as SVGPathElement;
    expect(path).toBeTruthy();
    // Drawn, not animating: the settled mark a returning guest also sees.
    expect(path.hasAttribute("stroke-dasharray")).toBe(false);
  });

  it("keeps the recorded tick but plays nothing when the guest dismisses mid-dwell", async () => {
    stubOkFetch();
    vi.useFakeTimers();
    render(() => <Harness />);
    await submit();

    // Escape during the dwell unmounts the sheet, which clears the dwell timer
    // before it can cue anything. The reply is already written, so the card
    // must still carry its permanent mark — the tick comes from the recorded
    // rows (`responded`), never from the celebration.
    fireEvent.keyDown(document, { key: "Escape" });
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS + TOTAL_DURATION_MS);

    expect(sheet()).toBeNull();
    expect(fillIsUp()).toBe(false);
    expect(respondButton().querySelector("svg")).toBeTruthy();
  });
});
