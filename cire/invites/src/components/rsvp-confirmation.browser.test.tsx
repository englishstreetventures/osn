import { cleanup, render } from "@solidjs/testing-library";
import { createSignal, Show } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

import "../styles/global.css";
import { EventCard } from "./EventCard";
import { hasHouseholdResponded, SWEEP_DURATION_MS, TOTAL_DURATION_MS } from "./rsvp-responded";
import { SAVED_DWELL_MS } from "./rsvp-saved";
import { RsvpModal } from "./RsvpModal";
import type { EventSummary, FamilyMember, RsvpSummary } from "./types";

/**
 * The `RsvpModal` → `EventCard` seam, driven end to end on REAL timers with the
 * REAL stylesheet, and measured rather than class-checked.
 *
 * `rsvp-confirmation.integration.test.tsx` owns the same seam in happy-dom, on
 * fake timers, asserting which classes are present at each beat. That is the
 * right tool for the ordering contract ("the fill must not turn on while the
 * sheet is still over the button") and the wrong one for the property a guest
 * actually reports: what the button is painted, seconds after the save.
 *
 * The difference matters here specifically because the real flow is nothing
 * like driving `justResponded` by hand (which is all `EventCard.browser.test.tsx`
 * does). On the real path the reply is recorded, the sheet dwells over the
 * button (`savedDwellMs`) with `responded` already true, and only THEN does
 * the celebration cue fire as the sheet unmounts — three state changes across
 * two components and two timers, with a CSS transition hanging off the last one.
 *
 * The card also renders inside the events section's themed wrapper here, with a
 * leftover inline `transform` of the kind `UnlockReveal.motion` leaves behind on
 * every `[data-event-card]`. A transformed ancestor creates a containing block
 * and a stacking context, so it is not inert scenery — it is the environment the
 * confirmation actually paints in.
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

const row = (guestId: string): RsvpSummary => ({
  guestId,
  eventId: "event-1",
  status: "attending",
  dietary: "",
});

/**
 * `InvitePage`'s wiring around the two real components, inside the events
 * section's themed + transformed wrapper. Kept out of `InvitePage` itself
 * because both design packs `vi.mock` `RsvpModal` at module level.
 */
function Harness(props: { members?: FamilyMember[] }) {
  const members = props.members ?? [priya];
  const [open, setOpen] = createSignal(false);
  const [justResponded, setJustResponded] = createSignal(false);
  const [rsvps, setRsvps] = createSignal<RsvpSummary[]>([]);

  return (
    <section style={{ "background-color": "var(--invite-section-bg, transparent)" }}>
      {/* The inline transform Motion One leaves on each card wrapper. */}
      <div data-event-card style={{ transform: "translateY(0px)", opacity: "1" }}>
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
      </div>
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
    </section>
  );
}

function respondButton(): HTMLButtonElement {
  return [...document.querySelectorAll("button")].find(
    (b) => b.textContent === "Respond",
  ) as HTMLButtonElement;
}

function fill(): HTMLElement {
  return respondButton().querySelector("span[aria-hidden='true']") as HTMLElement;
}

function scaleX(el: HTMLElement): number {
  const raw = getComputedStyle(el).scale;
  if (raw === "none") return 1;
  return Number.parseFloat(raw.split(" ")[0]!);
}

function sheet(): HTMLElement | null {
  return document.querySelector('[role="dialog"]');
}

function fieldsetFor(name: string): HTMLElement {
  for (const l of document.querySelectorAll("legend")) {
    if ((l.textContent ?? "").includes(name)) return l.closest("fieldset") as HTMLElement;
  }
  throw new Error(`fieldset for ${name} not found`);
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `vi.waitFor` options for the settled confirmation, in place of a fixed sleep.
 * The sweep cannot START until the sheet's dwell has elapsed and then runs for
 * `SWEEP_DURATION_MS` — `SAVED_DWELL_MS` is the dwell's ceiling (`savedDwellMs`
 * spends it as a budget from the click), so their sum is an upper bound on the
 * settle. A sleep sized to that sum has only its slack
 * to absorb one long task and otherwise samples the sweep mid-travel (~0.97).
 * The state being waited for is permanent, so waiting longer can never
 * overshoot, and `waitFor` returns the moment it holds. The default 1000ms
 * timeout is too short for the dwell plus the choreography, hence the explicit one.
 */
const SETTLED = { timeout: SAVED_DWELL_MS + SWEEP_DURATION_MS + 3000, interval: 50 };

/** Click "Attending" for one member, by name. */
function answer(name: string) {
  const buttons = [...fieldsetFor(name).querySelectorAll("button")];
  (buttons.find((b) => b.textContent === "Attending") as HTMLButtonElement).click();
}

function save() {
  (document.querySelector("button[type='submit']") as HTMLButtonElement).click();
}

function okFetchReturning(...rows: RsvpSummary[]) {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ rsvps: rows }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

describe("RSVP confirmation, end to end and painted", () => {
  // No fake timers here, so a leaked card from a previous test would still be
  // mounted (and still filled) when the next one queries for "Respond".
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("leaves the fill painted for the long haul after a complete save", async () => {
    vi.stubGlobal("fetch", okFetchReturning(row("guest-priya")));
    render(() => <Harness />);

    respondButton().click();
    await wait(0);
    answer("Priya");
    save();

    // The sheet dwells over the button with the reply already recorded. Nothing
    // may be animating underneath it yet. Anchored to the label flip rather than
    // to a 100ms sleep: this is a CEILING, and a long stall would let the dwell
    // fire first, making the sheet gone and the assertion meaningless.
    //
    // All three sampled inside ONE `waitFor` predicate, so they are read in a
    // single task. Asserted after the wait instead, they can straddle the
    // dwell's expiry — the poll sees "Saved", the runner stalls, and the sheet
    // is gone by the time the next line runs. That margin shrank with the dwell
    // (T-E1), and the assertion is about ORDERING, not duration, so it should
    // not have been leaning on the dwell being long in the first place.
    await vi.waitFor(() => {
      expect(document.querySelector("button[type='submit']")!.textContent).toContain("Saved");
      expect(sheet()).toBeTruthy();
      expect(scaleX(fill())).toBe(0);
    });

    // Sheet gone, sweep played.
    await vi.waitFor(() => {
      expect(sheet()).toBeNull();
      expect(scaleX(fill())).toBe(1);
    }, SETTLED);

    // Seconds past every timer in `rsvp-responded.ts` — the beat the guest
    // complaint is actually about. Kept to +2000 rather than a showier margin:
    // these are fixed sleeps in a real browser and the browser tier pays them in
    // wall clock, so buy only the headroom the assertion needs.
    await wait(TOTAL_DURATION_MS + 2000);
    expect(scaleX(fill())).toBe(1);
    expect(respondButton().querySelector("svg")).not.toBeNull();
  });

  it("keeps the button plain after a partial save, then fills once the party is complete", async () => {
    // First save answers only Priya; the second adds Raj and completes the
    // party. The API returns the whole family's rows each time, as the real one
    // does.
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ rsvps: [row("guest-priya")] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ rsvps: [row("guest-priya"), row("guest-raj")] }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
    );
    render(() => <Harness members={[priya, raj]} />);

    respondButton().click();
    await wait(0);
    answer("Priya");
    save();
    await vi.waitFor(() => expect(sheet()).toBeNull(), SETTLED);

    // A partial save is saved — but the button says nothing, because the
    // household has not finished answering for this event.
    expect(sheet()).toBeNull();
    expect(scaleX(fill())).toBe(0);
    expect(respondButton().querySelector("svg")).toBeNull();

    // Reopen, answer Raj (Priya stays prefilled), save again.
    respondButton().click();
    await wait(0);
    answer("Raj");
    save();
    await vi.waitFor(() => expect(scaleX(fill())).toBe(1), SETTLED);
    await wait(TOTAL_DURATION_MS + 2000);
    expect(scaleX(fill())).toBe(1);
    expect(respondButton().querySelector("svg")).not.toBeNull();
  });
});
