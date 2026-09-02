// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";

/**
 * EventsEditor is the interactive events editor (E6): a re-orderable event list
 * on the shared draft store, an add/edit drawer, delete-with-impact-confirm, and
 * a Save flow that posts the whole draft (events + guests) as DesiredState to
 * changes/preview, renders the shared preview, then applies. Auth/api/toast are
 * stubbed; the shared caches are reset per test.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import EventsEditor from "../../src/components/EventsEditor";
import { __resetEventsCache } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { confirmNavigation } from "../../src/lib/unsaved-guard";
import { authFetchMock, resetOrganiserMocks, toastSuccess } from "../test-support/mocks";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EVENTS = [
  {
    id: "evt_1",
    name: "Ceremony",
    slug: "ceremony",
    sortOrder: 0,
    startAt: "2026-11-14T15:00:00+11:00",
    // A real end, not "": `joinIso(stamped(splitIso(""), zone))` returns ""
    // whatever the implementation does, so an empty one left the `endAt` half
    // of `setTimezone`'s patch provably unexercised.
    endAt: "2026-11-14T17:00:00+11:00",
    timezone: "Australia/Sydney",
    address: "St Mary's",
    description: "",
    dressCodeDescription: null,
    dressCodePalette: null,
    pinterestUrl: null,
    mapsUrl: null,
    imageUrl: null,
    imageCrop: null,
  },
  {
    id: "evt_2",
    name: "Reception",
    slug: "reception",
    sortOrder: 1,
    startAt: "2026-11-14T18:00:00+11:00",
    endAt: "",
    timezone: "Australia/Sydney",
    address: "The Grounds",
    description: "",
    dressCodeDescription: null,
    dressCodePalette: null,
    pinterestUrl: null,
    mapsUrl: null,
    imageUrl: null,
    imageCrop: null,
  },
];

const GUESTS = [
  {
    guestId: "g_1",
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    firstName: "Ada",
    lastName: "Sharma",
    nickname: null,
    events: ["evt_1"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];

const HOUSEHOLDS = [
  {
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    guestCount: 1,
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];

function primeLoad() {
  authFetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith("/events")) return Promise.resolve(json(EVENTS));
    if (String(url).endsWith("/guests")) return Promise.resolve(json(GUESTS));
    if (String(url).endsWith("/households")) return Promise.resolve(json(HOUSEHOLDS));
    return Promise.resolve(json({}));
  });
}

beforeEach(() => {
  // happy-dom lacks window.confirm; default to OK.
  Object.defineProperty(window, "confirm", {
    configurable: true,
    value: vi.fn().mockReturnValue(true),
  });
});

describe("EventsEditor", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    __resetGuestsCache();
    __resetHouseholdsCache();
    __resetEventsCache();
  });

  it("renders the events in schedule order", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
    expect(screen.getByText("Reception")).toBeTruthy();
  });

  it("opens the drawer and edits an event name", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    // Open the first event's drawer.
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() => expect(screen.getByRole("dialog", { name: /Edit event/i })).toBeTruthy());

    const nameField = screen.getByLabelText("Event name") as HTMLInputElement;
    expect(nameField.value).toBe("Ceremony");
    fireEvent.input(nameField, { target: { value: "Wedding Ceremony" } });

    // The edit makes the draft dirty ⇒ the sticky Save bar appears.
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());
  });

  it("blocks save with an inline drawer error when a required field is blanked", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() => expect(screen.getByLabelText("Event name")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Event name"), { target: { value: "" } });

    await waitFor(() => expect(screen.getByText(/Event name is required/i)).toBeTruthy());
    const save = screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("exposes a focusable drag handle per event instead of arrow controls", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Reception")).toBeTruthy());

    // One grip per event, labelled by name AND position — a drag reports
    // nothing to assistive tech, so the label carries the position itself.
    // Re-ordering behaviour (pointer drag + keyboard) is covered in
    // EventsEditor.reorder.test.tsx.
    expect(screen.getByRole("button", { name: /Reorder Ceremony, position 1 of 2/i })).toBeTruthy();
    const grip = screen.getByRole("button", { name: /Reorder Reception, position 2 of 2/i });
    expect(grip.tagName).toBe("BUTTON"); // tabbable ⇒ it can own the keyboard path
    // The hint id is GENERATED per list rather than a hardcoded
    // `"reorder-hint"`, so several sortable lists can share a page without every
    // grip describing itself with whichever one won. Assert the link, not the id.
    const hintId = grip.getAttribute("aria-describedby")!;
    expect(hintId).toBeTruthy();
    expect(document.getElementById(hintId)?.textContent).toMatch(
      /press the up and down arrow keys/i,
    );
    expect(screen.getByText(/press the up and down arrow keys/i)).toBeTruthy();

    // The VISIBLE ▲/▼ pair is gone, but an Enter/Space-activated equivalent
    // survives for assistive tech — NVDA/JAWS browse mode never forwards the
    // grip's arrow keys, so removing this path entirely would be a regression.
    // It is screen-reader-only (`sr-only`), revealed on focus.
    const srUp = screen.getByRole("button", { name: /Move Reception up/i });
    expect(srUp.className).toContain("sr-only");
    expect(srUp.className).toContain("focus:not-sr-only");
    expect(screen.queryByText("▲")).toBeNull();
    expect(screen.queryByText("▼")).toBeNull();
    // Disabled at the list ends so AT reports the boundary.
    expect(
      (screen.getByRole("button", { name: /Move Ceremony up/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((srUp as HTMLButtonElement).disabled).toBe(false);
  });

  it("adds a new event via Add event", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    // A drawer opens for the new (blank) event, and a "New — saved on apply" badge shows.
    await waitFor(() => expect(screen.getByText(/saved on apply/i)).toBeTruthy());
  });

  // ── Start/End date + timezone ────────────────────────────────────────────
  //
  // The drawer reads each date back out of the ISO string it just wrote, so a
  // join that dropped a date lacking a time made the picker a silent no-op on
  // exactly the events that need it most — every newly-added one. These pin the
  // date surviving on its own, and the zone (not a hand-picked UTC offset)
  // deciding what offset the finished timestamp carries.

  it("keeps a start date picked before any time is typed", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    await waitFor(() => expect(screen.getByText(/saved on apply/i)).toBeTruthy());

    // A brand-new event has no time, so this is the exact case that used to
    // bounce straight back to the placeholder.
    fireEvent.click(screen.getByLabelText(/Start date, no date set/i));
    const grid = await waitFor(() => screen.getAllByRole("grid")[0]!);
    const today = grid.querySelector<HTMLButtonElement>('[aria-current="date"]')!;
    const pickedLabel = today.getAttribute("aria-label")!;
    fireEvent.click(today);

    // The trigger now shows the picked day rather than "Pick a date…".
    await waitFor(() => expect(screen.getByLabelText(`Start date: ${pickedLabel}`)).toBeTruthy());
    // …and it is a blocking partial, not an invented midnight.
    expect(screen.getByText(/Start time is required/i)).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("carries a new event from picked-date to a full zone-derived timestamp", async () => {
    // Pinned clock: the picker on a blank value opens on TODAY's month, and
    // this test needs a specific month (and a date whose zone offset is a fixed
    // known quantity — November in Sydney is AEDT).
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2026-11-01T09:00:00+11:00"));
    onTestFinished(() => {
      vi.useRealTimers();
    });

    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    await waitFor(() => expect(screen.getByText(/saved on apply/i)).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Event name"), { target: { value: "Mehendi" } });

    // The whole fix-1 + fix-2 interaction on the flow it was written for:
    // `joinIso`'s partial, `splitIso`'s date-only parse, `stamped()` against
    // `splitIso`'s `+00:00` fallback offset, and `validateDraft`'s new branch.
    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "Australia/Sydney" },
    });
    fireEvent.click(screen.getByLabelText(/Start date, no date set/i));
    const grid = await waitFor(() => screen.getAllByRole("grid")[0]!);
    fireEvent.click(within(grid).getByRole("gridcell", { name: /14 November 2026/ }));
    await waitFor(() => expect(screen.getByText(/Start time is required/i)).toBeTruthy());

    // 11:30, not 15:00 — the Ceremony fixture already starts at 15:00 on this
    // date, and its row would read the same.
    fireEvent.input(screen.getByLabelText("Start time"), { target: { value: "11:30" } });

    // The row states the LOCAL time and nothing else — the offset is a derived
    // storage detail, so it never reaches the screen.
    await waitFor(() => expect(screen.getByText(/Sat, 14 Nov 2026 · 11:30 am/)).toBeTruthy());
    expect(screen.queryByText(/\+11:00/)).toBeNull();
    expect(screen.queryByText(/Start time is required/i)).toBeNull();

    const save = screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    // …and the value that reaches the wire IS stamped: November in Sydney is
    // AEDT, so the offset is the one the ZONE is on for this event's own date,
    // not the `+00:00` the half-filled partial carried.
    fireEvent.click(save);
    await waitFor(() =>
      expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/changes/preview"))).toBe(
        true,
      ),
    );
    const body = JSON.parse(
      authFetchMock.mock.calls.find((c) => String(c[0]).endsWith("/changes/preview"))![1].body,
    );
    const mehendi = body.desiredState.events.find(
      (e: { name: string }) => e.name === "Mehendi",
    ) as { startAt: string };
    expect(mehendi.startAt).toBe("2026-11-14T11:30:00+11:00");
  });

  it("treats a half-filled End the same way, and clearing it re-opens the save", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    // Ceremony is complete, so any block here comes from the End edit alone.
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() => expect(screen.getByLabelText("End time")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("End time"), { target: { value: "" } });

    // A date with no time is the same blocking partial on the End side…
    await waitFor(() => expect(screen.getByText(/End time is required/i)).toBeTruthy());
    expect(
      (screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement).disabled,
    ).toBe(true);

    // …and clearing the DATE collapses it to "" (open-ended), which is valid.
    fireEvent.click(screen.getByLabelText(/^End date:/i));
    fireEvent.click(await waitFor(() => screen.getByText("Clear date")));
    await waitFor(() => expect(screen.queryByText(/End time is required/i)).toBeNull());
    expect(
      (screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("offers a timezone dropdown seeded with the organiser's own zone, not a UTC offset", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    const zone = (await waitFor(() => screen.getByLabelText("Timezone"))) as HTMLSelectElement;
    expect(zone.tagName).toBe("SELECT");
    expect(zone.value).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // The raw-offset pickers are gone — an offset is a fact about a zone on a
    // date, not a second thing to ask for.
    expect(screen.queryByLabelText(/UTC offset/i)).toBeNull();
  });

  it("derives the offset from the chosen zone and the event's own date, for BOTH ends", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    // Ceremony runs 15:00–17:00 +11:00 in Sydney. Re-homing it to Brisbane
    // (no DST) must restamp BOTH offsets to +10:00 without touching either
    // wall clock — the organiser moved the wedding, not the ceremony's hours.
    // Dropping `endAt` from the patch would leave a 15:00+10:00 start against
    // a 17:00+11:00 end: a reception an hour shorter than anyone typed.
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    const zone = (await waitFor(() => screen.getByLabelText("Timezone"))) as HTMLSelectElement;
    fireEvent.change(zone, { target: { value: "Australia/Brisbane" } });

    // The wall clocks are untouched on screen — a zone change moves the offset,
    // never the hours the organiser typed.
    await waitFor(() =>
      expect(screen.getByText(/Sat, 14 Nov 2026 · 3:00 pm – 5:00 pm/)).toBeTruthy(),
    );
    expect((screen.getByLabelText("Start time") as HTMLInputElement).value).toBe("15:00");
    expect((screen.getByLabelText("End time") as HTMLInputElement).value).toBe("17:00");
    // The select kept its new value — the option list is not rebuilt under it.
    expect(zone.value).toBe("Australia/Brisbane");

    // And the end really is restamped, not merely left alone: it reaches the
    // wire as +10:00.
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());
    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [],
              eventRemovals: [],
              familyCreates: [],
              familyUpdates: [],
              familyRemovals: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemovals: [],
              attendanceCreates: [],
              attendanceRemovals: [],
            },
          }),
        );
      }
      return Promise.resolve(json({}));
    });
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() =>
      expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/changes/preview"))).toBe(
        true,
      ),
    );
    const body = JSON.parse(
      authFetchMock.mock.calls.find((c) => String(c[0]).endsWith("/changes/preview"))![1].body,
    );
    const ceremony = body.desiredState.events.find(
      (e: { name: string }) => e.name === "Ceremony",
    ) as { startAt: string; endAt: string; timezone: string };
    expect(ceremony.startAt).toBe("2026-11-14T15:00:00+10:00");
    expect(ceremony.endAt).toBe("2026-11-14T17:00:00+10:00");
    expect(ceremony.timezone).toBe("Australia/Brisbane");
  });

  it("keeps an unresolvable imported zone's stored offset when another field is edited", async () => {
    // A spreadsheet import can carry a free-text zone this tz database can't
    // resolve ("AEST"). `stamped()` falls back to the offset already on the
    // value, so touching the time must not silently shift the event by hours.
    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/events")) {
        return Promise.resolve(
          json([
            { ...EVENTS[0], timezone: "AEST", startAt: "2026-11-14T15:00:00+10:00", endAt: "" },
          ]),
        );
      }
      if (u.endsWith("/guests")) return Promise.resolve(json([]));
      if (u.endsWith("/households")) return Promise.resolve(json([]));
      return Promise.resolve(json({}));
    });
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    const zone = (await waitFor(() => screen.getByLabelText("Timezone"))) as HTMLSelectElement;
    // The unknown zone leads the list under "Current", so the select shows what
    // is actually stored rather than the first option in the tz database.
    expect(zone.value).toBe("AEST");

    fireEvent.input(screen.getByLabelText("Start time"), { target: { value: "16:00" } });
    // The row can't format a time in a zone this runtime doesn't know, so it
    // falls back to the wall clock — still no offset on screen.
    await waitFor(() => expect(screen.getByText(/2026-11-14 16:00/)).toBeTruthy());
    expect(screen.queryByText(/\+10:00/)).toBeNull();

    // The hint names the zone, and that is all it can honestly say about it.
    // Read through `aria-describedby` rather than by text: "AEST" is also the
    // label of the "Current" option, so a bare text query is ambiguous.
    const hint = document.getElementById(zone.getAttribute("aria-describedby")!)!;
    expect(hint.textContent).toBe("Times below are local to AEST.");

    // The STORED offset is untouched underneath: an unresolvable zone can't be
    // re-derived from, so editing another field must not shift the event.
    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() =>
      expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/changes/preview"))).toBe(
        true,
      ),
    );
    const body = JSON.parse(
      authFetchMock.mock.calls.find((c) => String(c[0]).endsWith("/changes/preview"))![1].body,
    );
    expect((body.desiredState.events[0] as { startAt: string }).startAt).toBe(
      "2026-11-14T16:00:00+10:00",
    );
  });

  it("shows an empty zone as empty, not as the first zone in the database", async () => {
    // A legacy row can hold `timezone: ""`. A `<select>` whose value matches no
    // option displays the FIRST one, so without an explicit empty option this
    // read as "Africa/Abidjan" while the draft still held "" — and the
    // free-text escape hatch that used to make that recoverable is gone.
    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/events")) return Promise.resolve(json([{ ...EVENTS[0], timezone: "" }]));
      if (u.endsWith("/guests")) return Promise.resolve(json([]));
      if (u.endsWith("/households")) return Promise.resolve(json([]));
      return Promise.resolve(json({}));
    });
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    const zone = (await waitFor(() => screen.getByLabelText("Timezone"))) as HTMLSelectElement;
    expect(zone.value).toBe("");
    expect(screen.getByText("Select a timezone…")).toBeTruthy();
    // …and the required-field error agrees with what the control shows.
    expect(screen.getByText(/Timezone is required/i)).toBeTruthy();
  });

  it("spells the zone out with its abbreviation, and never with a UTC offset", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    // The drawer asks for a zone and two wall clocks. The offset is derived from
    // those, so there is nothing about it for an organiser to read or act on —
    // showing it only reopens the "is that a field I'm meant to set?" question
    // that deleting the offset select was supposed to close.
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() =>
      expect(screen.getByText("Times below are local to Australia/Sydney (AEDT).")).toBeTruthy(),
    );

    fireEvent.change(screen.getByLabelText("Timezone"), {
      target: { value: "Australia/Brisbane" },
    });
    await waitFor(() =>
      expect(screen.getByText("Times below are local to Australia/Brisbane (AEST).")).toBeTruthy(),
    );
    // Nowhere in the open drawer — hint, fields or summary row — is a raw offset.
    expect(document.body.textContent).not.toMatch(/UTC[+-]\d{2}:\d{2}/);
    expect(document.body.textContent).not.toMatch(/T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
  });

  it("runs the save flow: preview → shared modal → apply → toast", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() => expect(screen.getByLabelText("Event name")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Event name"), { target: { value: "Wedding Ceremony" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: ["1 event will be updated."],
            plan: {
              eventCreates: [],
              eventUpdates: [{}],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: ["1 event will be updated."],
            },
          }),
        );
      }
      if (u.endsWith("/changes/apply"))
        return Promise.resolve(json({ summary: { importId: "chg_1" } }));
      if (u.endsWith("/events"))
        return Promise.resolve(json([{ ...EVENTS[0], name: "Wedding Ceremony" }, EVENTS[1]]));
      if (u.endsWith("/guests")) return Promise.resolve(json(GUESTS));
      if (u.endsWith("/households")) return Promise.resolve(json(HOUSEHOLDS));
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    // The shared preview modal appears with the warning.
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: /Review changes before applying/i })).toBeTruthy(),
    );
    expect(screen.getByText(/1 event will be updated/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirm & save/i }));

    await waitFor(() =>
      expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/changes/apply"))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0]![0]).toMatch(/saved/i);

    const applyCall = authFetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith("/changes/apply"),
    )!;
    expect(JSON.parse(String((applyCall[1] as RequestInit).body)).changeId).toBe("chg_1");
  });

  it("surfaces a 409 apply as a re-preview prompt", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() => expect(screen.getByLabelText("Event name")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Event name"), { target: { value: "Wedding Ceremony" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [{}, {}],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
        );
      }
      if (u.endsWith("/changes/apply"))
        return Promise.resolve(json({ error: "State changed — re-preview" }, 409));
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: /Review changes before applying/i })).toBeTruthy(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Confirm & save/i }));

    await waitFor(() => expect(screen.getByText(/changed elsewhere/i)).toBeTruthy());
  });

  it("deletes an event after a confirm", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Reception")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete$/i })[1]!);
    // Reception is gone from the list; the draft is dirty.
    await waitFor(() => expect(screen.queryByText("Reception")).toBeNull());
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy();
  });

  /**
   * A schedule draft is as losable as a guest draft, and costlier: a deleted
   * event cascades to its attendance links and RSVPs. Both layers of the guard
   * are asserted here because the editor's own comment promises both, and the
   * `beforeunload` half was missing while the comment claimed it.
   */
  it("guards navigation and tab-close while the draft is dirty", async () => {
    primeLoad();
    const add = vi.spyOn(window, "addEventListener");
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Reception")).toBeTruthy());

    const beforeUnloadAdds = () => add.mock.calls.filter((c) => c[0] === "beforeunload").length;
    expect(confirmNavigation()).toBe(true);
    expect(beforeUnloadAdds()).toBe(0);

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete$/i })[1]!);
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    // happy-dom ships no window.confirm — stub it, as unsaved-guard's own tests do.
    const confirmSpy = vi.fn().mockReturnValue(false);
    vi.stubGlobal("confirm", confirmSpy);
    expect(confirmNavigation()).toBe(false);
    expect(confirmSpy).toHaveBeenCalled();
    vi.unstubAllGlobals();

    await waitFor(() => expect(beforeUnloadAdds()).toBe(1));
    add.mockRestore();
  });
});
