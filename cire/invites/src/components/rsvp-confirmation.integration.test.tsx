import { toast } from "@shared/toast";
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

vi.mock("@shared/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

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

const raj: FamilyMember = {
  guestId: "guest-raj",
  firstName: "Raj",
  lastName: "Sharma",
  nickname: null,
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
 *
 * `members` defaults to just Priya (every existing test's fixture); pass both
 * Sharmas to exercise a partial save. `existingRsvps={rsvps()}` threads the
 * accumulated state back in so reopening the sheet after a partial save
 * prefills what was already answered — the same wiring `InvitePage` itself
 * does with `claimResult().rsvps`.
 */
function Harness(props: { members?: FamilyMember[]; startingRsvps?: RsvpSummary[] } = {}) {
  const members = props.members ?? [priya];
  const [open, setOpen] = createSignal(false);
  const [justResponded, setJustResponded] = createSignal(false);
  // `startingRsvps` stands in for a household that already has rows on file
  // when the page loads — the precondition for the "edit an already-complete
  // reply" case, which must NOT re-run the celebration.
  const [rsvps, setRsvps] = createSignal<RsvpSummary[]>(props.startingRsvps ?? []);

  return (
    <>
      <EventCard
        event={event}
        responded={hasHouseholdResponded(event, members, rsvps())}
        justResponded={justResponded()}
        // Mirrors `InvitePage`: while the sheet is open it covers this button,
        // so the card must not put its mark up yet. Without this the reply is
        // recorded (`responded` true) `SAVED_DWELL_MS` before the sheet closes
        // and the fill sweeps in behind it, unseen.
        covered={open()}
        onCelebrated={() => setJustResponded(false)}
        onRespond={() => setOpen(true)}
        onDetails={() => {}}
      />
      <Show when={open()}>
        <RsvpModal
          event={event}
          members={members}
          existingRsvps={rsvps()}
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
    // The toast mock is a module-level singleton (the factory runs
    // once for the whole file), so its call history survives across tests
    // unless cleared here.
    vi.mocked(toast.success).mockClear();
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

  it("settles to a permanent fill and tick once the celebration ends", async () => {
    stubOkFetch();
    vi.useFakeTimers();
    render(() => <Harness />);
    await submit();
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);
    await vi.advanceTimersByTimeAsync(TOTAL_DURATION_MS);

    expect(fillIsUp()).toBe(true);
    const path = respondButton().querySelector("svg path") as SVGPathElement;
    expect(path).toBeTruthy();
    // Drawn, not animating: the settled mark a returning guest also sees.
    expect(path.hasAttribute("stroke-dasharray")).toBe(false);
  });

  it("still marks the button when the guest dismisses mid-dwell, just without the draw", async () => {
    stubOkFetch();
    vi.useFakeTimers();
    render(() => <Harness />);
    await submit();

    // Escape during the dwell unmounts the sheet, which clears the dwell timer
    // before it can cue the celebration. The reply is already written, so the
    // card must still end up fully marked: `covered` goes false as the sheet
    // leaves, and the card syncs its mark from the recorded rows (`responded`).
    //
    // This is the case #396 got half-right — it showed the tick but left the
    // fill off, so the button carried a bloom tick on plain gold until a reload
    // happened to re-seed it. The mark is one state now, so there is no such
    // in-between: a guest who dismisses early and one who watches the animation
    // land on the identical button.
    fireEvent.keyDown(document, { key: "Escape" });
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS + TOTAL_DURATION_MS);

    expect(sheet()).toBeNull();
    expect(fillIsUp()).toBe(true);
    const svg = respondButton().querySelector("svg");
    expect(svg).toBeTruthy();
    // Sitting on the fill, so the on-fill ink — and never animated, since no
    // celebration was ever cued.
    expect(svg!.getAttribute("class")).toContain("text-bg");
    const path = svg!.querySelector("path") as SVGPathElement;
    expect(path.hasAttribute("stroke-dasharray")).toBe(false);
  });

  it("plays nothing on an edit to an already-complete reply, and keeps the mark", async () => {
    // The sweep marks the CROSSING into a complete response, so a household
    // that comes back to change an answer gets the toast and no animation — and
    // critically, the mark it already earned does not blink off to be re-earned.
    stubOkFetch();
    vi.useFakeTimers();
    // Mount with Priya's reply already on file: the party (just Priya) is
    // complete before this sheet ever opens.
    render(() => <Harness startingRsvps={[savedRow]} />);

    // Already marked from the recorded rows.
    expect(fillIsUp()).toBe(true);

    await submit();

    // Advance ONLY the dwell. This is the frame a celebration would begin on,
    // and the only window in which its absence is observable — assert after
    // `TOTAL_DURATION_MS` as well and a celebration that ran and finished looks
    // identical to one that never started.
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);

    expect(sheet()).toBeNull();
    // Toast yes, celebration no: the tick is the settled one, not being drawn.
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);
    expect(fillIsUp()).toBe(true);
    const path = respondButton().querySelector("svg path") as SVGPathElement;
    expect(path.hasAttribute("stroke-dasharray")).toBe(false);
    expect(path.getAttribute("class") ?? "").not.toContain("animate-tick-draw");

    // And the mark is still there once every timer has run out.
    await vi.advanceTimersByTimeAsync(TOTAL_DURATION_MS);
    expect(fillIsUp()).toBe(true);
    expect(respondButton().querySelector("svg")).toBeTruthy();
  });

  it("only sweeps the fill once every invited member has answered — a partial save gets the toast, not the celebration", async () => {
    vi.useFakeTimers();
    // A fresh `Response` per call, not `mockResolvedValue(oneResponse)`: a body
    // can only be read once, so a reused instance makes the third submit throw
    // inside `res.json()` and surface as a connection error.
    const rajRow = { guestId: "guest-raj", eventId: "event-1", status: "declined", dietary: "" };
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(() => {
        call += 1;
        // First save answers Priya alone; every later save has the whole party.
        const rows = call === 1 ? [savedRow] : [savedRow, rajRow];
        return Promise.resolve(
          new Response(JSON.stringify({ rsvps: rows }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }),
    );
    render(() => <Harness members={[priya, raj]} />);

    // First save: only Priya answers. The household isn't fully responded yet,
    // so the toast fires but the fill never sweeps in.
    fireEvent.click(respondButton());
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(within(fieldsetFor("Priya")).getByText("Attending"));
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);

    expect(sheet()).toBeNull();
    expect(fillIsUp()).toBe(false);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(1);

    // Reopen and answer Raj too — now every invited member has replied, so
    // this save gets both the toast and the celebration.
    fireEvent.click(respondButton());
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(within(fieldsetFor("Raj")).getByText("Not attending"));
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);

    expect(fillIsUp()).toBe(true);
    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(2);
    // Drawing, i.e. this save really did celebrate.
    expect(
      (respondButton().querySelector("svg path") as SVGPathElement).getAttribute("class"),
    ).toContain("animate-tick-draw");

    // Let the celebration finish so `onCelebrated` clears `justResponded`.
    // Mandatory, not tidiness: leave the cue stuck true and the third save
    // below would be a no-op transition, and the test would pass for the wrong
    // reason — it would prove nothing about the `celebrate` gate.
    await vi.advanceTimersByTimeAsync(TOTAL_DURATION_MS);

    // THIRD save, same session: reopen and edit Raj's answer. The party was
    // already complete — and complete from rows THIS session wrote back through
    // `onSubmitted`, which is the only path that exercises `wasComplete` against
    // anything other than mount-time props. Toast, no celebration, mark intact.
    fireEvent.click(respondButton());
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(within(fieldsetFor("Raj")).getByText("Attending"));
    fireEvent.click(document.querySelector("button[type='submit']") as HTMLElement);
    await vi.advanceTimersByTimeAsync(SAVED_DWELL_MS);

    expect(vi.mocked(toast.success)).toHaveBeenCalledTimes(3);
    expect(fillIsUp()).toBe(true);
    const path = respondButton().querySelector("svg path") as SVGPathElement;
    expect(path.hasAttribute("stroke-dasharray")).toBe(false);
    expect(path.getAttribute("class") ?? "").not.toContain("animate-tick-draw");
  });
});
