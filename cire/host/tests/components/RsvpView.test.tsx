// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RsvpView is the in-dashboard RSVP summary: per event, a status tally and every
 * invited guest — replies (status + dietary + provenance badge) and the silent
 * ones as "No reply" rows — under one search box and one set of status chips.
 * Editors also get a record/edit affordance. The OSN auth + api helpers are
 * stubbed; this asserts the grouped render, the counts, the empty state,
 * provenance badging, the filtering, and the organiser-record flow.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import RsvpView from "../../src/components/RsvpView";
import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const ADA = {
  guestId: "g1",
  firstName: "Ada",
  lastName: "Sharma",
  familyName: "Sharma",
  familyCode: "SHARMA-WIDGET-AB3K9",
};
const CLEO = {
  guestId: "g3",
  firstName: "Cleo",
  lastName: "Jones",
  familyName: "Jones",
  familyCode: "JONES-KITE-77Q2",
};
const DEV = {
  guestId: "g4",
  firstName: "Dev",
  lastName: "Rao",
  familyName: "Rao",
  familyCode: "RAO-EMBER-51X8",
};

/**
 * Three events, and the tallies match the lists: `noResponse` is exactly the
 * length of `unresponded`, because that is the contract the API upholds. Ada is
 * invited to two of them, so a row count and a guest count differ — which is
 * what the status line has to get right.
 */
const VIEW = {
  events: [
    {
      id: "evt_1",
      name: "Ceremony",
      invited: 4,
      attending: 1,
      declined: 1,
      maybe: 1,
      responded: 3,
      noResponse: 1,
      guests: [
        {
          ...ADA,
          status: "attending" as const,
          dietary: "Gluten free",
          consentSource: "guest" as const,
        },
        {
          guestId: "g2",
          firstName: "Bo",
          lastName: "Jones",
          familyName: "Jones",
          familyCode: "JONES-KITE-77Q2",
          status: "declined" as const,
          dietary: "",
          consentSource: "organiser_attested" as const,
        },
        {
          ...DEV,
          status: "maybe" as const,
          dietary: "Nut allergy",
          consentSource: "guest" as const,
        },
      ],
      unresponded: [CLEO],
    },
    {
      id: "evt_2",
      name: "Reception",
      invited: 2,
      attending: 0,
      declined: 0,
      maybe: 0,
      responded: 0,
      noResponse: 2,
      guests: [],
      unresponded: [ADA, DEV],
    },
    {
      id: "evt_3",
      name: "Welcome drinks",
      invited: 0,
      attending: 0,
      declined: 0,
      maybe: 0,
      responded: 0,
      noResponse: 0,
      guests: [],
      unresponded: [],
    },
  ],
};

// Six rows over three events: 1 attending, 1 declined, 1 maybe, 3 no-reply.

/** The `dd` beside a tally's `dt`, so "Attending 1" is read as a pair. */
function tally(section: HTMLElement, label: string) {
  const dt = within(section).getByText(label, { selector: "dt" });
  return dt.parentElement?.querySelector("dd")?.textContent;
}

const chips = () => screen.getByRole("group", { name: "Filter by reply" });
const chip = (name: RegExp) => within(chips()).getByRole("button", { name });
const searchBox = () => screen.getByLabelText("Search guests");

describe("RsvpView", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("renders RSVPs grouped by event with correct counts", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);

    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
    // Both events render.
    expect(screen.getByText("Reception")).toBeTruthy();

    // The Ceremony section shows its responded guests + their status + dietary.
    const ceremony = screen.getByText("Ceremony").closest("section")!;
    expect(within(ceremony).getByText("Ada Sharma")).toBeTruthy();
    expect(within(ceremony).getByText("Gluten free")).toBeTruthy();
    expect(within(ceremony).getByText("Bo Jones")).toBeTruthy();
    // "Attending"/"Declined" appear in both the tally header (dt) and the status
    // badge — assert the guest-row badge specifically (within the table body).
    const tbody = ceremony.querySelector("tbody")!;
    expect(within(tbody as HTMLElement).getByText("Attending")).toBeTruthy();
    expect(within(tbody as HTMLElement).getByText("Declined")).toBeTruthy();

    // Each tally reads as its own pair, not as digits loose in the header.
    expect(tally(ceremony, "Attending")).toBe("1");
    expect(tally(ceremony, "Declined")).toBe("1");
    expect(tally(ceremony, "Maybe")).toBe("1");
    expect(tally(ceremony, "No reply")).toBe("1");
    expect(tally(ceremony, "Invited")).toBe("4");
  });

  it("shows a per-event empty note when the event has no guests at all", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);

    await waitFor(() => expect(screen.getByText("Welcome drinks")).toBeTruthy());
    // Nobody is invited to this one — distinct from an event whose guests are
    // all silent, which lists them as "No reply" rows.
    const drinks = screen.getByText("Welcome drinks").closest("section")!;
    expect(within(drinks).getByText(/No guests to show/i)).toBeTruthy();

    const reception = screen.getByText("Reception").closest("section")!;
    expect(within(reception).queryByText(/No guests to show/i)).toBeNull();
    expect(within(reception).getAllByText("No reply", { selector: "span" })).toHaveLength(2);
    expect(tally(reception, "No reply")).toBe("2");
  });

  it("lists a guest who has not replied in the same table, badged No reply", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);

    await waitFor(() => expect(screen.getByText("Cleo Jones")).toBeTruthy());
    const row = screen.getByText("Cleo Jones").closest("tr")!;
    expect(within(row).getByText("No reply")).toBeTruthy();
  });

  it("shows the no-events empty state when the wedding has no events", async () => {
    authFetchMock.mockResolvedValueOnce(json({ events: [] }));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText(/No events yet/i)).toBeTruthy());
  });

  it("redirects to login on a 401", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "unauthorised" }, 401));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
  });

  it("surfaces an error when the load fails", async () => {
    authFetchMock.mockResolvedValueOnce(json({ error: "boom" }, 500));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText(/Could not load RSVPs/i)).toBeTruthy());
  });

  it("keeps one live region mounted, silent until it has something to say", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // Mounted from the start: a region created at the moment it fills is not
    // announced by most screen readers.
    const live = screen.getByRole("status");
    expect(live.textContent).toBe("");

    fireEvent.input(searchBox(), { target: { value: "jones" } });
    // The printed count is immediate; the announcement waits for the typing to
    // stop, so it never reads a number the host has already typed past.
    expect(screen.getByText(/Showing 2 of 6 guest rows/i)).toBeTruthy();
    expect(live.textContent).toBe("");
    await waitFor(() => expect(live.textContent).toMatch(/Showing 2 of 6 guest rows/i));

    fireEvent.input(searchBox(), { target: { value: "" } });
    await waitFor(() => expect(live.textContent).toBe(""));
  });

  it("badges a host-entered reply distinctly from a guest-submitted one", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    // Bo's row is organiser_attested → the provenance badge appears; Ada's
    // (guest) row does not carry it.
    expect(screen.getByText(/Host-entered/i)).toBeTruthy();
    expect(screen.getAllByText(/Host-entered/i)).toHaveLength(1);
  });

  it("does not show record/edit controls for a viewer (canEdit falsy)", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Edit reply for/i })).toBeNull();
    // The no-reply row is still listed — a viewer may read it, not act on it.
    expect(screen.getByText("Cleo Jones")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Record reply for/i })).toBeNull();
  });

  it("names each row's control after the guest it acts on", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // A screen reader lands on six identical "Edit"/"Record" buttons otherwise.
    expect(screen.getByRole("button", { name: "Edit reply for Ada Sharma" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record reply for Cleo Jones" })).toBeTruthy();
    // Ada is invited to two events and silent on one: two rows, two names.
    expect(screen.getByRole("button", { name: "Record reply for Ada Sharma" })).toBeTruthy();
  });

  it("filters every event by a status chip", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // The chip carries its count: three rows owe a reply across the events.
    const noReply = chip(/^No reply/i);
    expect(noReply.textContent).toContain("3");
    // "All" is the pressed one until a host picks another.
    expect(chip(/^All/i).getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(noReply);
    expect(noReply.getAttribute("aria-pressed")).toBe("true");
    expect(chip(/^All/i).getAttribute("aria-pressed")).toBe("false");
    expect(
      within(chips())
        .getAllByRole("button")
        .filter((b) => b.getAttribute("aria-pressed") === "true"),
    ).toHaveLength(1);

    const ceremony = screen.getByText("Ceremony").closest("section")!;
    expect(within(ceremony).getByText("Cleo Jones")).toBeTruthy();
    expect(within(ceremony).queryByText("Ada Sharma")).toBeNull();
    expect(screen.getByText(/Showing 3 of 6 guest rows/i)).toBeTruthy();

    // The event sections stay put, with their tallies, and say why they're bare.
    expect(screen.getByText("Reception")).toBeTruthy();
    fireEvent.click(chip(/^Attending/i));
    expect(within(ceremony).getByText("Ada Sharma")).toBeTruthy();
    expect(within(ceremony).queryByText("Cleo Jones")).toBeNull();
    const reception = screen.getByText("Reception").closest("section")!;
    expect(within(reception).getByText(/No guests match this filter/i)).toBeTruthy();
    expect(tally(reception, "No reply")).toBe("2");

    // Back to All restores every row.
    fireEvent.click(chip(/^All/i));
    expect(within(ceremony).getByText("Cleo Jones")).toBeTruthy();
    expect(screen.queryByText(/Showing \d+ of/i)).toBeNull();
  });

  it("counts on the chips describe the whole wedding, not the search", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.input(searchBox(), { target: { value: "jones" } });
    // Narrowing to the Joneses must not renumber the chips — they are the map
    // out of the current search, not a description of it.
    expect(chip(/^All/i).textContent).toContain("6");
    expect(chip(/^Attending/i).textContent).toContain("1");
    expect(chip(/^No reply/i).textContent).toContain("3");
  });

  it("searches across name, household and dietary text", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.input(searchBox(), { target: { value: "jones" } });
    expect(screen.getByText("Bo Jones")).toBeTruthy();
    expect(screen.getByText("Cleo Jones")).toBeTruthy();
    expect(screen.queryAllByText("Ada Sharma")).toHaveLength(0);

    // Dietary text is searchable — the caterer's question. Ada is invited to
    // two events; only the row that carries the note matches.
    fireEvent.input(searchBox(), { target: { value: "gluten" } });
    expect(screen.getByText("Ada Sharma")).toBeTruthy();
    expect(screen.queryByText("Bo Jones")).toBeNull();

    // Clearing the box puts every row back and drops the status line.
    fireEvent.input(searchBox(), { target: { value: "" } });
    expect(screen.getAllByText("Ada Sharma")).toHaveLength(2);
    expect(screen.getByText("Bo Jones")).toBeTruthy();
    expect(screen.queryByText(/Showing \d+ of/i)).toBeNull();
  });

  it("applies the search and the chip together", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.input(searchBox(), { target: { value: "jones" } });
    fireEvent.click(chip(/^No reply/i));
    expect(screen.getByText("Cleo Jones")).toBeTruthy();
    expect(screen.queryByText("Bo Jones")).toBeNull();
    expect(screen.getByText(/Showing 1 of 6 guest rows/i)).toBeTruthy();
  });

  it("says so when a filter matches nobody", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.input(searchBox(), { target: { value: "nobody" } });
    const ceremony = screen.getByText("Ceremony").closest("section")!;
    expect(within(ceremony).getByText(/No guests match this filter/i)).toBeTruthy();
    expect(screen.getByText(/Showing 0 of 6 guest rows/i)).toBeTruthy();
  });

  it("editor records a phone RSVP: PUTs consent-attested body and reloads", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(VIEW)) // initial load
      .mockResolvedValueOnce(
        json({ rsvp: { status: "attending", consentSource: "organiser_attested" } }),
      ) // PUT
      .mockResolvedValueOnce(json(VIEW)); // reload after save
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // Cleo hasn't replied; her row carries the Record button.
    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));

    // Enter dietary text → the consent checkbox appears + gates submit.
    const dietary = await screen.findByLabelText(/Dietary requirements/i);
    fireEvent.input(dietary, { target: { value: "Nut allergy" } });

    // Saving without ticking consent surfaces the gate error, no PUT yet.
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    await waitFor(() =>
      expect(screen.getByText(/before storing dietary requirements/i)).toBeTruthy(),
    );
    // Only the initial load fired so far.
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Tick consent + save → the PUT fires with the attested body.
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(3));
    const putCall = authFetchMock.mock.calls[1]!;
    expect(putCall[0]).toContain("/api/organiser/weddings/wed_a/guests/g3/rsvps/evt_1");
    expect(putCall[1]?.method).toBe("PUT");
    const body = JSON.parse(putCall[1]?.body as string) as {
      status: string;
      dietary: string;
      dietaryConsent: boolean;
    };
    expect(body).toEqual({ status: "attending", dietary: "Nut allergy", dietaryConsent: true });
  });

  it("editor edits an existing reply (prefilled, overwrites)", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(VIEW))
      .mockResolvedValueOnce(
        json({ rsvp: { status: "declined", consentSource: "organiser_attested" } }),
      )
      .mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    // Edit Ada's existing reply.
    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    // The status select is prefilled to her current status ("attending").
    const status = (await screen.findByLabelText(/Status/i)) as HTMLSelectElement;
    expect(status.value).toBe("attending");
    fireEvent.change(status, { target: { value: "declined" } });
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(3));
    const putCall = authFetchMock.mock.calls[1]!;
    expect(putCall[0]).toContain("/api/organiser/weddings/wed_a/guests/g1/rsvps/evt_1");
    const body = JSON.parse(putCall[1]?.body as string) as { status: string };
    expect(body.status).toBe("declined");
  });

  it("keeps an unrelated event's row identity across a reload, patches the one that changed", async () => {
    // The point of the store + mapArray split: a reload must not rebuild every
    // <section>/<tr> in the wedding, only the one event whose data actually moved.
    const RELOADED = {
      events: VIEW.events.map((event) =>
        event.id === "evt_1"
          ? {
              ...event,
              attending: 2,
              responded: 4,
              noResponse: 0,
              guests: [
                ...event.guests,
                {
                  ...CLEO,
                  status: "attending" as const,
                  dietary: "Nut allergy",
                  consentSource: "organiser_attested" as const,
                },
              ],
              unresponded: [],
            }
          : event,
      ),
    };
    authFetchMock
      .mockResolvedValueOnce(json(VIEW)) // initial load
      .mockResolvedValueOnce(
        json({ rsvp: { status: "attending", consentSource: "organiser_attested" } }),
      ) // PUT
      .mockResolvedValueOnce(json(RELOADED)); // reload after save
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // Reception never changes across this save — Ada's silent row there is the
    // control. A whole-list rebuild would swap this node out even though nothing
    // about Reception moved.
    const reception = screen.getByText("Reception").closest("section")!;
    const untouchedRow = within(reception).getByText("Ada Sharma").closest("tr")!;

    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));
    const dietary = await screen.findByLabelText(/Dietary requirements/i);
    fireEvent.input(dietary, { target: { value: "Nut allergy" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(3));

    // Cleo's own row is the one that should have moved — she now has a reply,
    // so a brand-new <tr> for her is correct. The reload body still has to parse
    // and land in the store after the third call resolves, so requery the whole
    // way down on each tick: a captured <section> would go stale the moment a
    // rebuild swapped it out, and this half of the test must fail for its own
    // reason, not that one.
    await waitFor(() => {
      const ceremony = screen.getByText("Ceremony").closest("section")!;
      const cleoRow = within(ceremony).getByText("Cleo Jones").closest("tr")!;
      expect(within(cleoRow).getByText("Attending")).toBeTruthy();
    });

    const receptionAfter = screen.getByText("Reception").closest("section")!;
    const rowAfter = within(receptionAfter).getByText("Ada Sharma").closest("tr")!;
    expect(rowAfter).toBe(untouchedRow);
    expect(document.body.contains(untouchedRow)).toBe(true);
  });

  it("closes the open editor when a filter hides the row it belongs to", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    expect(await screen.findByLabelText(/Status/i)).toBeTruthy();

    // Ada is attending, so "Declined" takes her row away. Leaving the form open
    // under a row that is gone invites a save the host cannot see land.
    fireEvent.click(chip(/^Declined/i));
    expect(screen.queryByLabelText(/Status/i)).toBeNull();

    // Reopening after the filter is cleared still works.
    fireEvent.click(chip(/^All/i));
    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    expect(await screen.findByLabelText(/Status/i)).toBeTruthy();
  });
});
