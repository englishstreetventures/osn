// @vitest-environment happy-dom
import {
  ORGANISER_DIETARY_ATTESTATION,
  ORGANISER_PLUS_ONE_DIETARY_ATTESTATION,
} from "@cire/dietary";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RsvpView is the in-dashboard RSVP summary, one event at a time: a tab per
 * event, and in the chosen event's panel its status tally, a search box and
 * status chips that act on it, and every invited guest — replies (status +
 * dietary + provenance badge) and the silent ones as "No reply" rows. Editors
 * also get a record/edit affordance. The OSN auth + api helpers are stubbed;
 * this asserts the render per event, the counts, the empty state, provenance
 * badging, the filtering, and the organiser-record flow. The tab list's
 * keyboard, the sort heads and the sticky table are measured in real Chromium
 * (`RsvpView.events.browser.test.tsx`).
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("../../src/lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

vi.mock("@shared/toast", async () => {
  const { toastMock } = await import("../test-support/mocks");
  return toastMock();
});

const downloadBlobMock = vi.fn();
vi.mock("../../src/lib/download", () => ({
  downloadBlob: (name: string, blob: Blob) => downloadBlobMock(name, blob),
}));

// The marketing site's origin, set apart from every default so a link built
// from anything else shows.
vi.mock("../../src/lib/osn", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/osn")>()),
  CIRE_MARKETING_URL: "https://marketing.test",
}));

// The change feed has its own suite (RsvpView.changes.test.tsx). Stubbed here so
// this file's fetch order stays the RSVP read and the organiser's own writes;
// the pure helpers stay real.
vi.mock("../../src/lib/rsvp-changes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/rsvp-changes")>()),
  fetchRsvpChangeRows: async () => null,
  markRsvpChangesSeen: async () => {},
}));

import RsvpView from "../../src/components/RsvpView";
import { authFetchMock, redirectSpy, resetOrganiserMocks, toastError } from "../test-support/mocks";
import { mockViewport } from "../test-support/viewport";

/**
 * Set by the one test that needs the picker's narrow shell, and reset here for
 * every other test in the file — a leaked narrow viewport adds sixteen preset
 * checkboxes to the page, which breaks any test reaching for the singular
 * `getByRole("checkbox")`.
 */
let restoreViewport = () => {};

/** The organiser PUT's answer: the reply as stored. */
function saved(
  guestId: string,
  status: "attending" | "declined" | "maybe",
  consentSource: "guest" | "organiser_attested" | "inviter_attested",
  dietary = "",
  dietaryPresets: readonly string[] = [],
) {
  return { rsvp: { guestId, eventId: "evt_1", status, dietary, dietaryPresets, consentSource } };
}

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
          dietary: "",
          dietaryPresets: ["gluten"],
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
          dietaryPresets: [],
          consentSource: "organiser_attested" as const,
        },
        {
          ...DEV,
          status: "maybe" as const,
          dietary: "Airborne is fine, contact is not.",
          dietaryPresets: ["nuts", "other"],
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

const chips = () => screen.getByRole("group", { name: /^Filter .+ by reply$/ });
const chip = (name: RegExp) => within(chips()).getByRole("button", { name });
const searchBox = () => screen.getByLabelText(/^Search .+ guests$/);
/** An event's tab; its name starts with the event's. */
const tab = (name: string) => screen.getByRole("tab", { name: new RegExp(`^${name}`) });
/** The panel of the event on screen. */
const panel = () => screen.getByRole("tabpanel");
/** Show an event, and hand back its panel. */
function show(name: string) {
  fireEvent.click(tab(name));
  return panel();
}

describe("RsvpView", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
    downloadBlobMock.mockReset();
    restoreViewport();
    restoreViewport = () => {};
  });

  it("shows who answered, marking a reply sent through a linked account", async () => {
    const view = structuredClone(VIEW);
    view.events[0]!.guests[0] = {
      ...view.events[0]!.guests[0]!,
      submittedBy: { guestId: "g9", firstName: "Maya", viaLink: true },
    } as never;
    view.events[0]!.guests[1] = {
      ...view.events[0]!.guests[1]!,
      submittedBy: { guestId: "g8", firstName: "Sam", viaLink: false },
    } as never;
    authFetchMock.mockResolvedValueOnce(json(view));
    render(() => <RsvpView weddingId="wed_a" />);

    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
    expect(screen.getByText(/Answered by Maya/)).toBeTruthy();
    expect(screen.getByText(/Answered by Sam/)).toBeTruthy();
    expect(screen.getAllByText("linked musubi")).toHaveLength(1);
  });

  it("shows one event at a time, the first to begin with, with correct counts", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);

    await waitFor(() => expect(tab("Ceremony")).toBeTruthy());
    // Every event has a tab; the first is chosen, and only its panel shows.
    expect(screen.getAllByRole("tab").map((t) => t.getAttribute("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    expect(screen.getAllByRole("tabpanel")).toHaveLength(1);
    expect(panel().getAttribute("aria-labelledby")).toBe(tab("Ceremony").id);
    // Each tab counts the guests on its list.
    expect(tab("Ceremony").getAttribute("aria-label")).toBe("Ceremony, 4 guests");
    expect(tab("Reception").getAttribute("aria-label")).toBe("Reception, 2 guests");
    expect(tab("Welcome drinks").getAttribute("aria-label")).toBe("Welcome drinks, 0 guests");

    // The Ceremony panel shows its responded guests + their status + dietary.
    const ceremony = panel();
    expect(within(ceremony).getByText("Ada Sharma")).toBeTruthy();
    // Ada picked from the list and typed nothing. Before the dashboard rendered
    // presets this cell was blank while the CSV showed the requirement in full.
    expect(within(ceremony).getByText("Gluten / coeliac")).toBeTruthy();
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

    // Another tab swaps the panel's contents for that event's.
    const reception = show("Reception");
    expect(tab("Reception").getAttribute("aria-selected")).toBe("true");
    expect(within(reception).queryByText("Bo Jones")).toBeNull();
    expect(within(reception).getByText("Ada Sharma")).toBeTruthy();
    expect(tally(reception, "Invited")).toBe("2");
  });

  it("opens on the event its address names, and reports the one a host picks", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    const onEvent = vi.fn();
    render(() => <RsvpView weddingId="wed_a" event="evt_2" onEvent={onEvent} />);
    await waitFor(() => expect(tab("Reception").getAttribute("aria-selected")).toBe("true"));
    expect(onEvent).not.toHaveBeenCalled();

    fireEvent.click(tab("Ceremony"));
    expect(onEvent).toHaveBeenCalledWith("evt_1");
    expect(within(panel()).getByText("Bo Jones")).toBeTruthy();
  });

  it("follows the address when it names another event while the page is open", async () => {
    // Back, Forward, or an address pasted over the open page.
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    const onEvent = vi.fn();
    const [event, setEvent] = createSignal<string | undefined>("evt_1");
    render(() => <RsvpView weddingId="wed_a" event={event()} onEvent={onEvent} />);
    await waitFor(() => expect(tab("Ceremony").getAttribute("aria-selected")).toBe("true"));

    setEvent("evt_2");
    expect(tab("Reception").getAttribute("aria-selected")).toBe("true");
    expect(within(panel()).queryByText("Bo Jones")).toBeNull();
    expect(within(panel()).getByText("Ada Sharma")).toBeTruthy();
    // The view followed the address; it reported nothing back.
    expect(onEvent).not.toHaveBeenCalled();
  });

  it("names a one-guest event's tab in the singular, and each table by its event", async () => {
    const view = structuredClone(VIEW);
    view.events[1]!.unresponded = [ADA];
    view.events[1]!.invited = 1;
    view.events[1]!.noResponse = 1;
    authFetchMock.mockResolvedValueOnce(json(view));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(tab("Reception")).toBeTruthy());
    expect(tab("Reception").getAttribute("aria-label")).toBe("Reception, 1 guest");
    // The table scrolls with the page, so it is no region of its own: its
    // caption names it.
    expect(screen.getByRole("table", { name: "RSVPs for Ceremony" })).toBeTruthy();
    show("Reception");
    expect(screen.getByRole("table", { name: "RSVPs for Reception" })).toBeTruthy();
  });

  it("saves to the event on screen, never to an id the address named", async () => {
    // The address is the host's to edit. Its event id only picks among the
    // events the API returned; a save goes to the shown event's own id.
    authFetchMock
      .mockResolvedValueOnce(json(VIEW))
      .mockResolvedValueOnce(json(saved("g3", "attending", "organiser_attested")));
    render(() => <RsvpView weddingId="wed_a" canEdit event="evt_x/../../x" />);
    await waitFor(() => expect(tab("Ceremony").getAttribute("aria-selected")).toBe("true"));

    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));
    fireEvent.click(await screen.findByRole("button", { name: /Save reply/i }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(authFetchMock.mock.calls[1]![0]).toBe(
      "https://api.test/api/organiser/weddings/wed_a/guests/g3/rsvps/evt_1",
    );
  });

  it("opens on the first event when its address names none it knows", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" event="evt_gone" />);
    await waitFor(() => expect(tab("Ceremony").getAttribute("aria-selected")).toBe("true"));
    expect(within(panel()).getByText("Bo Jones")).toBeTruthy();
  });

  it("shows a per-event empty note when the event has no guests at all", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);

    await waitFor(() => expect(tab("Welcome drinks")).toBeTruthy());
    // Nobody is invited to this one — distinct from an event whose guests are
    // all silent, which lists them as "No reply" rows.
    const drinks = show("Welcome drinks");
    expect(within(drinks).getByText(/No guests to show/i)).toBeTruthy();

    const reception = show("Reception");
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
    // stop, so it never reads a number the host has already typed past. Both
    // name the event, since the search acts on it alone.
    expect(screen.getByText("Showing 2 of 4 guests for Ceremony.")).toBeTruthy();
    expect(live.textContent).toBe("");
    await waitFor(() => expect(live.textContent).toBe("Showing 2 of 4 guests for Ceremony."));

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

  // The file leaves the portal, so only an owner is offered it; the API's
  // owner gate refuses everyone else.
  it("offers the RSVP download to no viewer or editor, and points a viewer at none", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    const { unmount } = render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Download RSVPs/i })).toBeNull();
    expect(screen.queryByText(/download/i)).toBeNull();
    unmount();

    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit canManage={false} />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Download RSVPs/i })).toBeNull();
  });

  it("offers an owner no RSVP download while no event invites anyone", async () => {
    const empty = structuredClone(VIEW);
    for (const event of empty.events) Object.assign(event, { invited: 0, guests: [] });
    authFetchMock.mockResolvedValueOnce(json(empty));
    render(() => <RsvpView weddingId="wed_a" canEdit canManage weddingSlug="nadia-sam" />);
    await waitFor(() => expect(tab("Ceremony")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Download RSVPs/i })).toBeNull();
  });

  // A second click while the first download runs would spend another call
  // from the owner's export rate limit and save the file twice.
  it("holds the RSVP download to one request while it runs, then names the file", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit canManage />);
    const button = await screen.findByRole("button", { name: "Download RSVPs (CSV)" });
    // An icon, as the Households tab's downloads are: its name is its label,
    // and the shell's tooltip shows the same words.
    expect(button.textContent).toBe("");
    expect(button.getAttribute("data-tip")).toBe("Download RSVPs (CSV)");
    let answer: (res: Response) => void = () => {};
    authFetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => (answer = resolve)));
    fireEvent.click(button);
    await waitFor(() => expect(button.getAttribute("aria-label")).toBe("Exporting RSVPs…"));
    expect(button).toHaveProperty("disabled", true);
    fireEvent.click(button);
    const csvCalls = () => authFetchMock.mock.calls.filter((c) => String(c[0]).endsWith(".csv"));
    expect(csvCalls().map((c) => String(c[0]))).toEqual([
      "https://api.test/api/organiser/weddings/wed_a/rsvps.csv",
    ]);

    answer(
      new Response("Family Code\r\n", { status: 200, headers: { "Content-Type": "text/csv" } }),
    );
    // No slug handed down: the wedding id names the file, as the API's own
    // Content-Disposition does.
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(downloadBlobMock.mock.calls[0]![0]).toBe("cire-rsvps-wed_a.csv");
    expect(button.getAttribute("aria-label")).toBe("Download RSVPs (CSV)");
  });

  // Both ways a lapsed session shows: the API's 401, and the auth client's
  // refresh failing before any request goes out.
  it.each([
    [
      "answers 401",
      () => authFetchMock.mockResolvedValueOnce(json({ error: "unauthorised" }, 401)),
    ],
    ["cannot refresh", () => authFetchMock.mockRejectedValueOnce(new Error("AuthExpiredError"))],
  ])("sends an owner whose session %s to sign in rather than download", async (_, lapse) => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit canManage weddingSlug="nadia-sam" />);
    const button = await screen.findByRole("button", { name: "Download RSVPs (CSV)" });
    lapse();
    fireEvent.click(button);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    expect(downloadBlobMock).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });

  it("saves no file when the RSVP download is refused, says so, and offers it again", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit canManage weddingSlug="nadia-sam" />);
    const button = await screen.findByRole("button", { name: "Download RSVPs (CSV)" });
    authFetchMock.mockResolvedValueOnce(json({ error: "forbidden" }, 403));
    fireEvent.click(button);
    await waitFor(() => expect(toastError).toHaveBeenCalledWith("RSVP export failed. Try again."));
    expect(downloadBlobMock).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Download RSVPs (CSV)" })).toHaveProperty(
      "disabled",
      false,
    );
  });

  it("gives each replies table a fixed layout with one sized column per heading", async () => {
    // The class contract only: `RsvpView.layout.browser.test.tsx` measures what
    // it does. A table with a `<col>` short of its headings, or one more, sizes
    // the odd column from nothing.
    for (const canEdit of [true, false]) {
      authFetchMock.mockResolvedValueOnce(json(VIEW));
      render(() => <RsvpView weddingId="wed_a" canEdit={canEdit} />);
      await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
      const table = screen.getByText("Bo Jones").closest("table")!;
      expect(table.parentElement!.className).toContain("[&>table]:table-fixed");
      expect(table.querySelectorAll("colgroup > col")).toHaveLength(
        table.querySelectorAll("thead th").length,
      );
      expect(table.querySelectorAll("thead th")).toHaveLength(canEdit ? 5 : 4);
      cleanup();
    }
  });

  it("names each row's control after the guest it acts on", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // A screen reader lands on identical "Edit"/"Record" buttons otherwise.
    expect(screen.getByRole("button", { name: "Edit reply for Ada Sharma" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Record reply for Cleo Jones" })).toBeTruthy();
    // Ada is invited to two events and silent on one: her row there names her
    // as one still to answer.
    show("Reception");
    expect(screen.getByRole("button", { name: "Record reply for Ada Sharma" })).toBeTruthy();
  });

  it("filters the event on screen by a status chip", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // The chips act on the event on screen, and say so.
    expect(chips().getAttribute("aria-label")).toBe("Filter Ceremony by reply");
    // The chip carries its count: one Ceremony row owes a reply.
    const noReply = chip(/^No reply/i);
    expect(noReply.textContent).toContain("1");
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

    expect(within(panel()).getByText("Cleo Jones")).toBeTruthy();
    expect(within(panel()).queryByText("Ada Sharma")).toBeNull();
    expect(screen.getByText("Showing 1 of 4 guests for Ceremony.")).toBeTruthy();
    // Each tab counts what the chip would leave of its own list.
    expect(tab("Reception").getAttribute("aria-label")).toBe("Reception, 2 matching");
    expect(tab("Welcome drinks").getAttribute("aria-label")).toBe("Welcome drinks, 0 matching");

    // The chip stays chosen on another event, and the tallies stay the API's.
    fireEvent.click(chip(/^Attending/i));
    const reception = show("Reception");
    expect(chip(/^Attending/i).getAttribute("aria-pressed")).toBe("true");
    expect(within(reception).getByText(/No guests match this filter/i)).toBeTruthy();
    expect(tally(reception, "No reply")).toBe("2");

    // Back to All restores every row.
    fireEvent.click(chip(/^All/i));
    expect(within(panel()).getByText("Ada Sharma")).toBeTruthy();
    expect(screen.queryByText(/Showing \d+ of/i)).toBeNull();
  });

  it("counts on the chips describe the event on screen, not the search", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.input(searchBox(), { target: { value: "jones" } });
    // Narrowing to the Joneses must not renumber the chips — they are the map
    // out of the current search, not a description of it.
    expect(chip(/^All/i).textContent).toContain("4");
    expect(chip(/^Attending/i).textContent).toContain("1");
    expect(chip(/^No reply/i).textContent).toContain("1");

    // Another event, its own counts.
    show("Reception");
    expect(chip(/^All/i).textContent).toContain("2");
    expect(chip(/^No reply/i).textContent).toContain("2");
  });

  it("searches across name, household and dietary text", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // The box names the event it searches.
    expect(searchBox().getAttribute("placeholder")).toMatch(/^Search Ceremony guests/);
    fireEvent.input(searchBox(), { target: { value: "jones" } });
    expect(screen.getByText("Bo Jones")).toBeTruthy();
    expect(screen.getByText("Cleo Jones")).toBeTruthy();
    expect(screen.queryAllByText("Ada Sharma")).toHaveLength(0);

    // Dietary text is searchable — the caterer's question. Ada is invited to
    // two events; only the row that carries the note matches, and the other
    // event's tab says it holds no match.
    fireEvent.input(searchBox(), { target: { value: "gluten" } });
    expect(screen.getByText("Ada Sharma")).toBeTruthy();
    expect(screen.queryByText("Bo Jones")).toBeNull();
    expect(tab("Reception").getAttribute("aria-label")).toBe("Reception, 0 matching");

    // The search stays when the event changes.
    show("Reception");
    expect((searchBox() as HTMLInputElement).value).toBe("gluten");
    expect(within(panel()).getByText(/No guests match this filter/i)).toBeTruthy();

    // Clearing the box puts every row back and drops the status line.
    fireEvent.input(searchBox(), { target: { value: "" } });
    expect(within(panel()).getByText("Ada Sharma")).toBeTruthy();
    expect(screen.queryByText(/Showing \d+ of/i)).toBeNull();
  });

  it("shows and finds a stored preset key this build does not know", async () => {
    // The portal can be a build older than the API. A row whose only answer is
    // such a key must not read "--", which tells the couple the guest has no
    // requirement, and searching for it must find the row.
    const withUnknown = structuredClone(VIEW);
    const bo = withUnknown.events[0]!.guests.find((g) => g.guestId === "g2")!;
    bo.dietaryPresets = ["lupin"];
    authFetchMock.mockResolvedValueOnce(json(withUnknown));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    const row = screen.getByText("Bo Jones").closest("tr")!;
    expect(within(row).getByText("Lupin")).toBeTruthy();
    expect(within(row).queryByText("--")).toBeNull();

    fireEvent.input(searchBox(), { target: { value: "lupin" } });
    expect(screen.getByText("Bo Jones")).toBeTruthy();
    expect(screen.queryAllByText("Ada Sharma")).toHaveLength(0);
  });

  it("applies the search and the chip together", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.input(searchBox(), { target: { value: "jones" } });
    fireEvent.click(chip(/^No reply/i));
    expect(screen.getByText("Cleo Jones")).toBeTruthy();
    expect(screen.queryByText("Bo Jones")).toBeNull();
    expect(screen.getByText("Showing 1 of 4 guests for Ceremony.")).toBeTruthy();
  });

  it("says so when a filter matches nobody", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.input(searchBox(), { target: { value: "nobody" } });
    expect(within(panel()).getByText(/No guests match this filter/i)).toBeTruthy();
    expect(screen.getByText("Showing 0 of 4 guests for Ceremony.")).toBeTruthy();
  });

  it("editor records a phone RSVP: PUTs a consent-attested body", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(VIEW)) // initial load
      .mockResolvedValueOnce(json(saved("g3", "attending", "organiser_attested"))); // PUT
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    // Cleo hasn't replied; her row carries the Record button.
    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));

    // Type into the free-text box → the attestation checkbox appears + gates
    // submit. ("Dietary requirements" now names the preset picker's group.)
    const dietary = await screen.findByLabelText(/Anything else/i);
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

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const putCall = authFetchMock.mock.calls[1]!;
    expect(putCall[0]).toContain("/api/organiser/weddings/wed_a/guests/g3/rsvps/evt_1");
    expect(putCall[1]?.method).toBe("PUT");
    const body = JSON.parse(putCall[1]?.body as string) as {
      status: string;
      dietary: string;
      dietaryPresets: readonly string[];
      dietaryConsent: boolean;
    };
    // Typed into "Other" with nothing picked from the list — the server is what
    // adds `other`, so the body carries the presets exactly as the form held them.
    expect(body).toEqual({
      status: "attending",
      dietary: "Nut allergy",
      dietaryPresets: [],
      dietaryConsent: true,
      dietaryAttestation: ORGANISER_DIETARY_ATTESTATION.version,
      dietaryAttestedName: "",
    });
  });

  it("editor records a preset-only reply: the attestation appears with no free text", async () => {
    // The gap the free-text case above cannot see. Before this rule, ticking a
    // preset and typing nothing sent `dietaryConsent: true` with no checkbox
    // ever on screen — an Art. 9(2)(a) attestation nobody made. The picker is
    // `@cire/ui/dietary-presets-popover`, which collapses behind a trigger above
    // 48rem, so the narrow viewport is what puts the checkboxes on the page.
    restoreViewport = mockViewport(false);
    authFetchMock
      .mockResolvedValueOnce(json(VIEW)) // initial load
      .mockResolvedValueOnce(json(saved("g3", "attending", "organiser_attested"))); // PUT
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));

    // Nothing picked and nothing typed → no attestation to make yet.
    await screen.findByLabelText(/Anything else/i);
    expect(screen.queryByLabelText(/I confirm the guest consented/i)).toBeNull();

    // A preset alone is special-category data, so the attestation must appear.
    fireEvent.click(screen.getByRole("checkbox", { name: "Halal" }));
    const consent = await screen.findByLabelText(/I confirm the guest consented/i);

    // And it gates the save, exactly as the free text does.
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    await waitFor(() =>
      expect(screen.getByText(/before storing dietary requirements/i)).toBeTruthy(),
    );
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const putCall = authFetchMock.mock.calls[1]!;
    expect(putCall[0]).toContain("/api/organiser/weddings/wed_a/guests/g3/rsvps/evt_1");
    const body = JSON.parse(putCall[1]?.body as string) as {
      status: string;
      dietary: string;
      dietaryPresets: readonly string[];
      dietaryConsent: boolean;
    };
    expect(body).toEqual({
      status: "attending",
      dietary: "",
      dietaryPresets: ["halal"],
      dietaryConsent: true,
      dietaryAttestation: ORGANISER_DIETARY_ATTESTATION.version,
      dietaryAttestedName: "",
    });
  });

  it("asks for a reload when the API refuses the attestation as out of date", async () => {
    // A portal tab opened before a change to the attestation wording shows the
    // old words; the API refuses them rather than store evidence of copy it no
    // longer stamps, and the organiser needs to know a reload fixes it.
    restoreViewport = mockViewport(false);
    authFetchMock
      .mockResolvedValueOnce(json(VIEW)) // initial load
      .mockResolvedValueOnce(json({ error: "dietary_attestation_outdated" }, 422)); // PUT
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));
    fireEvent.click(await screen.findByRole("checkbox", { name: "Halal" }));
    fireEvent.click(
      await screen.findByLabelText(new RegExp(ORGANISER_DIETARY_ATTESTATION.text.slice(0, 30))),
    );
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    expect(await screen.findByText(/This page is out of date/i)).toBeTruthy();
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  // The refusal is written under the form, so the box it is about names it; a
  // refusal of the save itself is not the box's.
  it("names the consent box by its refusal, and only by its own", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(VIEW)) // initial load
      .mockResolvedValueOnce(json({ error: "forbidden" }, 403)); // PUT
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));
    fireEvent.input(await screen.findByLabelText(/Anything else/i), {
      target: { value: "Nut allergy" },
    });
    const consent = screen.getByLabelText(
      new RegExp(ORGANISER_DIETARY_ATTESTATION.text.slice(0, 30)),
    ) as HTMLInputElement;
    expect(consent.hasAttribute("aria-describedby")).toBe(false);
    expect(consent.hasAttribute("aria-invalid")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    const refusal = await screen.findByRole("alert");
    expect(refusal.textContent).toMatch(/Confirm the guest consented/);
    const described = document.getElementById(consent.getAttribute("aria-describedby") ?? "");
    expect(described?.textContent).toMatch(/Confirm the guest consented before storing/);
    expect(consent.getAttribute("aria-invalid")).toBe("true");

    fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    expect(await screen.findByText(/You don't have permission/)).toBeTruthy();
    expect(consent.hasAttribute("aria-describedby")).toBe(false);
    expect(consent.hasAttribute("aria-invalid")).toBe(false);
  });

  it("editor changes only the status of an existing reply: no attestation, a status-only body", async () => {
    // Narrow, so the prefilled preset is a checkbox on the page rather than a
    // label inside a closed popover trigger.
    restoreViewport = mockViewport(false);
    authFetchMock
      .mockResolvedValueOnce(json(VIEW))
      .mockResolvedValueOnce(json(saved("g1", "declined", "guest")));
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    // Edit Ada's existing reply.
    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    // The status select is prefilled to her current status ("attending").
    const status = (await screen.findByLabelText(/Status/i)) as HTMLSelectElement;
    expect(status.value).toBe("attending");

    // Ada's stored answer is `["gluten"]`, so the editor opens with that preset
    // ticked, says a save keeps it, and asks for no attestation: nothing new is
    // being stored.
    expect(
      (screen.getByRole("checkbox", { name: "Gluten / coeliac" }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByLabelText(/I confirm the guest consented/i)).toBeNull();
    const save = screen.getByRole("button", { name: /Save reply/i });
    expect(describedText(save)).toContain("Saving without changing these");
    expect(describedText(save)).toContain("Gluten");

    fireEvent.change(status, { target: { value: "declined" } });
    fireEvent.click(save);

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const putCall = authFetchMock.mock.calls[1]!;
    expect(putCall[0]).toContain("/api/organiser/weddings/wed_a/guests/g1/rsvps/evt_1");
    // The WHOLE body. No dietary field is what tells the API to keep the
    // guest's answer and their own consent record; resending the answer would
    // restamp it as an attestation nobody made.
    expect(JSON.parse(putCall[1]?.body as string)).toEqual({ status: "declined" });
  });

  it("editor treats an answer edited and put back as unedited", async () => {
    restoreViewport = mockViewport(false);
    authFetchMock
      .mockResolvedValueOnce(json(VIEW))
      .mockResolvedValueOnce(json(saved("g1", "maybe", "guest")));
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    await screen.findByLabelText(/Status/i);

    const dairy = screen.getByRole("checkbox", { name: "Dairy" });
    fireEvent.click(dairy);
    expect(screen.getByLabelText(/I confirm the guest consented/i)).toBeTruthy();
    fireEvent.click(dairy);
    expect(screen.queryByLabelText(/I confirm the guest consented/i)).toBeNull();
    // Only whitespace added to the free text is no edit either.
    fireEvent.input(screen.getByLabelText(/Anything else/i), { target: { value: "  " } });
    expect(screen.queryByLabelText(/I confirm the guest consented/i)).toBeNull();

    fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: "maybe" } });
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(authFetchMock.mock.calls[1]![1]?.body as string)).toEqual({
      status: "maybe",
    });
  });

  it("editor asks for a fresh, unticked attestation once an existing answer is edited", async () => {
    restoreViewport = mockViewport(false);
    authFetchMock
      .mockResolvedValueOnce(json(VIEW))
      .mockResolvedValueOnce(json(saved("g1", "attending", "organiser_attested")));
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    await screen.findByLabelText(/Status/i);

    fireEvent.click(screen.getByRole("checkbox", { name: "Dairy" }));
    const consent = screen.getByLabelText(/I confirm the guest consented/i) as HTMLInputElement;
    expect(consent.checked).toBe(false);
    expect(screen.queryByText(/Saving without changing these/i)).toBeNull();

    // Unticked, the save is refused before any PUT.
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    // An alert, so a screen reader hears the refusal the moment it appears.
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Confirm the guest consented before storing/i,
    );
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(authFetchMock.mock.calls[1]![1]?.body as string)).toEqual({
      status: "attending",
      dietary: "",
      dietaryPresets: ["gluten", "dairy"],
      dietaryConsent: true,
      dietaryAttestation: ORGANISER_DIETARY_ATTESTATION.version,
      dietaryAttestedName: "",
    });
  });

  it("editor keeps a stored preset key this build does not know when another is ticked", async () => {
    // The vocabulary grows on the server first, and an open portal keeps the
    // build it loaded. Ada's stored answer carries a key missing from this
    // build's vocabulary; an organiser ticking another preset must not erase it
    // from the row.
    restoreViewport = mockViewport(false);
    const withUnknown = structuredClone(VIEW);
    const ada = withUnknown.events[0]!.guests.find((g) => g.guestId === ADA.guestId)!;
    ada.dietaryPresets = ["gluten", "a_future_key"];
    authFetchMock
      .mockResolvedValueOnce(json(withUnknown))
      .mockResolvedValueOnce(json(saved("g1", "attending", "organiser_attested")));
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    await screen.findByLabelText(/Status/i);

    fireEvent.click(screen.getByRole("checkbox", { name: "Dairy" }));
    fireEvent.click(screen.getByLabelText(/I confirm the guest consented/i));
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(authFetchMock.mock.calls[1]![1]?.body as string) as {
      dietaryPresets: readonly string[];
    };
    expect(body.dietaryPresets).toEqual(["gluten", "dairy", "a_future_key"]);
  });

  it("editor shows a stored preset key this build does not know, and unticking it clears with no attestation", async () => {
    // The organiser's side of the rule the guest sheet follows: a key missing
    // from this build's vocabulary is still a dietary requirement, so it shows as
    // a checked pill. Unticked, the row has no dietary data left, so there is
    // nothing to attest to and the save must not claim consent.
    restoreViewport = mockViewport(false);
    const withUnknown = structuredClone(VIEW);
    const ada = withUnknown.events[0]!.guests.find((g) => g.guestId === ADA.guestId)!;
    ada.dietaryPresets = ["a_future_key"];
    authFetchMock
      .mockResolvedValueOnce(json(withUnknown))
      .mockResolvedValueOnce(json(saved("g1", "attending", "organiser_attested")));
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    await screen.findByLabelText(/Anything else/i);

    const pill = screen.getByRole("checkbox", { name: "A future key" }) as HTMLInputElement;
    expect(pill.checked).toBe(true);
    // Unedited, the stored answer is kept as given, with no new attestation.
    expect(screen.queryByLabelText(/I confirm the guest consented/i)).toBeNull();

    fireEvent.click(pill);
    expect(pill.checked).toBe(false);
    expect(screen.queryByLabelText(/I confirm the guest consented/i)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const body = JSON.parse(authFetchMock.mock.calls[1]![1]?.body as string) as {
      dietaryPresets: readonly string[];
      dietaryConsent: boolean;
    };
    expect(body.dietaryPresets).toEqual([]);
    expect(body.dietaryConsent).toBe(false);
  });

  it("editor shows no attestation when the existing reply carries no dietary data", async () => {
    // The other branch of the prefill rule. Bo's stored reply has neither
    // presets nor free text, so there is nothing to attest to and the checkbox
    // must be absent — a prefill rewritten to tick unconditionally would pass
    // the case above and fail here.
    restoreViewport = mockViewport(false);
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Bo Jones" }));

    await screen.findByLabelText(/Anything else/i);
    expect(screen.queryByLabelText(/I confirm the guest consented/i)).toBeNull();
    expect(
      (screen.getByRole("checkbox", { name: "Gluten / coeliac" }) as HTMLInputElement).checked,
    ).toBe(false);
  });

  it("patches the saved row and its tallies from the PUT, with no reload", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(VIEW)) // initial load
      .mockResolvedValueOnce(
        json(saved("g3", "attending", "organiser_attested", "Nut allergy", ["other"])),
      ); // PUT
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    // Reception's tab, by node: the save names Ceremony, so only Ceremony's
    // rows are merged again, and every other event keeps its tab.
    const receptionTab = tab("Reception");

    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));
    const dietary = await screen.findByLabelText(/Anything else/i);
    fireEvent.input(dietary, { target: { value: "Nut allergy" } });
    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    // Cleo's row now carries her reply, and the header counts moved with it.
    // Requery the whole way down on each tick: a captured <section> would go
    // stale the moment a rebuild swapped it out.
    await waitFor(() => {
      const ceremony = panel();
      const cleoRow = within(ceremony).getByText("Cleo Jones").closest("tr")!;
      expect(within(cleoRow).getByText("Attending")).toBeTruthy();
      expect(within(cleoRow).getByText("Host-entered")).toBeTruthy();
      expect(within(cleoRow).queryByText("Host-updated")).toBeNull();
      expect(tally(ceremony, "Attending")).toBe("2");
      expect(tally(ceremony, "No reply")).toBe("0");
    });
    // The PUT was the only request after the load.
    expect(authFetchMock).toHaveBeenCalledTimes(2);

    // Reception is the control: the save named Ceremony, so Reception's list
    // and count are as they were, on the same tab.
    expect(tab("Reception")).toBe(receptionTab);
    expect(tab("Reception").getAttribute("aria-label")).toBe("Reception, 2 guests");
    const reception = show("Reception");
    const adaThere = within(reception).getByText("Ada Sharma").closest("tr")!;
    expect(within(adaThere).getByText("No reply")).toBeTruthy();
  });

  it("moves a changed status between the header counts and badges a host's update", async () => {
    restoreViewport = mockViewport(false);
    authFetchMock
      .mockResolvedValueOnce(json(VIEW))
      .mockResolvedValueOnce(json(saved("g1", "declined", "guest", "", ["gluten"])));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    fireEvent.change(await screen.findByLabelText(/Status/i), { target: { value: "declined" } });
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => {
      const ceremony = panel();
      expect(tally(ceremony, "Attending")).toBe("0");
      expect(tally(ceremony, "Declined")).toBe("2");
      const adaRow = within(ceremony).getByText("Ada Sharma").closest("tr")!;
      // The guest's own dietary answer stays, so the badge says a host changed
      // the status, not that a host entered the reply.
      expect(within(adaRow).getByText("Host-updated")).toBeTruthy();
      expect(within(adaRow).queryByText("Host-entered")).toBeNull();
    });
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });

  it("badges a host's update from the loaded view, and only there", async () => {
    // Dev's reply (the third) is the one a host last changed.
    const [ada, bo, dev] = VIEW.events[0]!.guests;
    const view = {
      events: [{ ...VIEW.events[0]!, guests: [ada, bo, { ...dev!, statusRecordedByHost: true }] }],
    };
    authFetchMock.mockResolvedValueOnce(json(view));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    const rowFor = (name: string) => screen.getByText(name).closest("tr")!;
    expect(within(rowFor("Dev Rao")).getByText("Host-updated")).toBeTruthy();
    expect(within(rowFor("Ada Sharma")).queryByText("Host-updated")).toBeNull();
  });

  it("reads each badge's explanation to a screen reader, not from a hover title", async () => {
    // Ada's reply came from her household, sent through a linked account; Bo's
    // a host recorded; Dev's status a host changed since.
    const [ada, bo, dev] = VIEW.events[0]!.guests;
    const view = {
      events: [
        {
          ...VIEW.events[0]!,
          guests: [
            {
              ...ada!,
              consentSource: "inviter_attested" as const,
              submittedBy: { guestId: "g9", firstName: "Maya", viaLink: true },
            },
            bo,
            { ...dev!, statusRecordedByHost: true },
          ],
        },
      ],
    };
    authFetchMock.mockResolvedValueOnce(json(view));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    const cellNamed = (text: string) =>
      screen.getByRole("cell", { name: (name) => name.includes(text) });
    expect(
      cellNamed(
        "Household-entered Given by the household that brought them, not by the plus-one. A host may have changed the status since; the dietary requirements are the household's.",
      ),
    ).toBeTruthy();
    expect(cellNamed("linked musubi Sent from a signed-in linked musubi account")).toBeTruthy();
    expect(cellNamed("Host-entered Recorded by a host (phone/paper RSVP)")).toBeTruthy();
    expect(
      cellNamed(
        "Host-updated A host last set this status. The dietary requirements are still the ones the guest or their household gave.",
      ),
    ).toBeTruthy();
    // A title beside the text would hand a screen reader the same words twice.
    expect(document.querySelector("tbody [title]")).toBeNull();

    // The key names every mark, each line ending on one full stop whether its
    // words carry their own or not.
    fireEvent.click(screen.getByRole("button", { name: "What the reply icons mean" }));
    const key = await screen.findByRole("dialog", { name: "What the reply icons mean" });
    expect(key.textContent).toContain("— Recorded by a host (phone/paper RSVP).");
    expect(key.textContent).toContain("their household gave.");
    expect(key.textContent).not.toMatch(/\.\./);
  });

  it.each([
    ["an answer that is not JSON", () => new Response("ok", { status: 200 })],
    ["a reply for a guest the page does not hold", () => json(saved("gone", "attending", "guest"))],
  ])("reloads on %s", async (_what, answer) => {
    authFetchMock
      .mockResolvedValueOnce(json(VIEW))
      .mockResolvedValueOnce(answer())
      .mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    fireEvent.change(await screen.findByLabelText(/Status/i), { target: { value: "maybe" } });
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(3));
    expect(authFetchMock.mock.calls[2]![0]).toContain("/rsvps");
  });

  it("reloads when the PUT's answer cannot be folded in", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(VIEW))
      .mockResolvedValueOnce(json({ rsvp: { status: "attending" } }))
      .mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Ada Sharma" }));
    fireEvent.change(await screen.findByLabelText(/Status/i), { target: { value: "maybe" } });
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(3));
    expect(authFetchMock.mock.calls[2]![0]).toContain("/rsvps");
  });

  it("keeps an open editor, and what was typed in it, with its event across a switch", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Record reply for Cleo Jones" }));
    fireEvent.input(await screen.findByLabelText(/Anything else/i), {
      target: { value: "Shellfish" },
    });

    // Another event: the form belongs to Ceremony, so it is not drawn here.
    show("Reception");
    expect(screen.queryByLabelText(/Anything else/i)).toBeNull();

    // Back again, the half-typed answer is still there.
    show("Ceremony");
    expect((screen.getByLabelText(/Anything else/i) as HTMLTextAreaElement).value).toBe(
      "Shellfish",
    );
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

/**
 * Plus-ones: a guest row like any other, marked with who brought them, and a
 * reply the household gave for them badged apart from a guest's own and an
 * organiser's. Sam and Kit carry their inviter's name from the API; Ren's
 * inviter it could not name.
 */
const PLUS_ONE_VIEW = {
  events: [
    {
      id: "evt_1",
      name: "Ceremony",
      invited: 5,
      attending: 2,
      declined: 0,
      maybe: 1,
      responded: 3,
      noResponse: 2,
      guests: [
        {
          guestId: "g2",
          firstName: "Bo",
          lastName: "Jones",
          familyName: "Jones",
          familyCode: "JONES-KITE-77Q2",
          status: "attending" as const,
          dietary: "",
          dietaryPresets: [],
          consentSource: "guest" as const,
          plusOneOf: null,
          plusOneOfName: null,
        },
        {
          guestId: "p1",
          firstName: "Sam",
          lastName: "Lee",
          familyName: "Jones",
          familyCode: "JONES-KITE-77Q2",
          status: "attending" as const,
          dietary: "",
          dietaryPresets: [],
          consentSource: "inviter_attested" as const,
          plusOneOf: "g2",
          plusOneOfName: "Bo Jones",
        },
        {
          ...DEV,
          status: "maybe" as const,
          dietary: "",
          dietaryPresets: [],
          consentSource: "organiser_attested" as const,
          plusOneOf: null,
          plusOneOfName: null,
        },
      ],
      unresponded: [
        {
          guestId: "p2",
          firstName: "Kit",
          lastName: "Moss",
          familyName: "Rao",
          familyCode: "RAO-EMBER-51X8",
          plusOneOf: "g4",
          plusOneOfName: "Dev Rao",
        },
        {
          guestId: "p3",
          firstName: "Ren",
          lastName: "Ito",
          familyName: "Sharma",
          familyCode: "SHARMA-WIDGET-AB3K9",
          plusOneOf: "g1",
          plusOneOfName: null,
        },
      ],
    },
  ],
};

/** What an API that sends the link but not the name serves: `plusOneOfName`
 *  is absent, not null. */
const LINK_WITHOUT_NAME = {
  events: [
    {
      ...PLUS_ONE_VIEW.events[0]!,
      unresponded: [
        {
          guestId: "p2",
          firstName: "Kit",
          lastName: "Moss",
          familyName: "Rao",
          familyCode: "RAO-EMBER-51X8",
          plusOneOf: "g4",
        },
      ],
      noResponse: 1,
    },
  ],
};

/** The same wedding once the household can give a plus-one's dietary answers:
 *  Sam's reply carries requirements the organiser path cannot store. */
function withSamDietary(dietaryPresets: string[], dietary: string) {
  return {
    events: PLUS_ONE_VIEW.events.map((event) => ({
      ...event,
      guests: event.guests.map((guest) =>
        guest.guestId === "p1" ? { ...guest, dietaryPresets, dietary } : guest,
      ),
    })),
  };
}

/** The row whose Guest cell starts with `name` — not one whose marker names
 *  them as the inviter. */
const findRow = (name: string) =>
  [...document.querySelectorAll<HTMLElement>("tbody > tr")].find((tr) =>
    tr.querySelector("td")?.textContent?.trim().startsWith(name),
  );
const rowOf = (name: string) => findRow(name)!;

/** The text of every element an `aria-describedby` names, in order. */
function describedText(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

describe("RsvpView — plus-ones", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("marks a plus-one's row with the guest who brought them", async () => {
    authFetchMock.mockResolvedValueOnce(json(PLUS_ONE_VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(findRow("Sam Lee")).toBeTruthy());

    expect(within(rowOf("Sam Lee")).getByText("Plus-one of Bo Jones")).toBeTruthy();
    expect(within(rowOf("Kit Moss")).getByText("Plus-one of Dev Rao")).toBeTruthy();
    // An inviter the API could not name still leaves the row marked.
    expect(within(rowOf("Ren Ito")).getByText("Plus-one of another guest")).toBeTruthy();
    expect(within(rowOf("Bo Jones")).queryByText(/Plus-one of/)).toBeNull();
    expect(screen.getAllByText(/^Plus-one of/)).toHaveLength(3);
  });

  it("badges a household-given reply apart from a guest's own and an organiser's", async () => {
    authFetchMock.mockResolvedValueOnce(json(PLUS_ONE_VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(findRow("Sam Lee")).toBeTruthy());

    expect(within(rowOf("Sam Lee")).getByText("Household-entered")).toBeTruthy();
    expect(within(rowOf("Sam Lee")).queryByText("Host-entered")).toBeNull();
    expect(within(rowOf("Dev Rao")).getByText("Host-entered")).toBeTruthy();
    expect(within(rowOf("Dev Rao")).queryByText("Household-entered")).toBeNull();
    // A guest's own reply carries neither badge.
    expect(within(rowOf("Bo Jones")).queryByText(/-entered$/)).toBeNull();
    expect(screen.getAllByText("Household-entered")).toHaveLength(1);
  });

  it("finds a plus-one by the guest who brought them", async () => {
    authFetchMock.mockResolvedValueOnce(json(PLUS_ONE_VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(findRow("Sam Lee")).toBeTruthy());

    fireEvent.input(searchBox(), { target: { value: "bo" } });
    expect(screen.getByText("Showing 2 of 5 guests for Ceremony.")).toBeTruthy();
    expect(findRow("Sam Lee")).toBeTruthy();

    fireEvent.input(searchBox(), { target: { value: "plus-one" } });
    expect(screen.getByText("Showing 3 of 5 guests for Ceremony.")).toBeTruthy();
    expect(findRow("Bo Jones")).toBeUndefined();
  });

  it("records a plus-one's reply as a status only when the dietary fields are left alone", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(PLUS_ONE_VIEW))
      .mockResolvedValueOnce(json(saved("p2", "declined", "organiser_attested")));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(findRow("Kit Moss")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Record reply for Kit Moss" }));
    const status = await screen.findByLabelText(/Status/i);
    expect(screen.getByLabelText(/Anything else/i)).toBeTruthy();
    // Nothing stored to keep, so no note, and nothing typed, so no attestation
    // and no request to share the privacy notice.
    expect(screen.queryByText(/Saving without changing these/i)).toBeNull();
    expect(screen.queryByLabelText(/I confirm the plus-one consented/i)).toBeNull();
    expect(screen.queryByText(/Share our privacy notice/i)).toBeNull();

    fireEvent.change(status, { target: { value: "declined" } });
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const putCall = authFetchMock.mock.calls[1]!;
    expect(putCall[0]).toContain("/api/organiser/weddings/wed_a/guests/p2/rsvps/evt_1");
    expect(JSON.parse(putCall[1]?.body as string)).toEqual({ status: "declined" });
  });

  it("records a plus-one's dietary requirements under the plus-one's own attestation", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(PLUS_ONE_VIEW))
      .mockResolvedValueOnce(json(saved("p2", "attending", "organiser_attested")));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(findRow("Kit Moss")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Record reply for Kit Moss" }));
    fireEvent.input(await screen.findByLabelText(/Anything else/i), {
      target: { value: "No shellfish" },
    });
    // The plus-one's wording, never the guest's.
    expect(screen.queryByLabelText(/I confirm the guest consented/i)).toBeNull();
    const consent = screen.getByLabelText(
      ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.text,
    ) as HTMLInputElement;
    expect(consent.checked).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Confirm the plus-one consented before storing/i,
    );
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    fireEvent.click(consent);
    fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(authFetchMock.mock.calls[1]![1]?.body as string)).toEqual({
      status: "attending",
      dietary: "No shellfish",
      dietaryPresets: [],
      dietaryConsent: true,
      dietaryAttestation: ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.version,
      dietaryAttestedName: "Kit Moss",
    });
  });

  it("asks the organiser to share the privacy page under a plus-one's attestation", async () => {
    authFetchMock.mockResolvedValueOnce(json(PLUS_ONE_VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(findRow("Kit Moss")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Record reply for Kit Moss" }));
    fireEvent.input(await screen.findByLabelText(/Anything else/i), {
      target: { value: "No shellfish" },
    });
    const box = screen.getByLabelText(ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.text);
    const link = screen.getByRole("link", {
      name: /cireweddings\.com\/privacy/,
    }) as HTMLAnchorElement;
    const line = link.closest("p")!;

    expect(line.textContent).toBe(
      "Share our privacy notice with them: cireweddings.com/privacy (opens in a new tab)",
    );
    // The page the line names, on the marketing site, in a new tab so the
    // open form keeps what was typed.
    expect(link.getAttribute("href")).toBe("https://marketing.test/privacy");
    expect(link.target).toBe("_blank");
    expect(link.rel).toBe("noopener noreferrer");
    // Under the box it goes with, and outside its label.
    expect(box.closest("label")!.compareDocumentPosition(line)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it.each([
    ["plus_one_changed", 409],
    ["plus_one_dietary_unavailable", 422],
    ["dietary_attestation_mismatch", 422],
    ["dietary_attestation_outdated", 422],
  ] as const)(
    "asks for a reload when the API refuses the plus-one's attestation with %s",
    async (error, status) => {
      authFetchMock
        .mockResolvedValueOnce(json(PLUS_ONE_VIEW))
        .mockResolvedValueOnce(json({ error }, status));
      render(() => <RsvpView weddingId="wed_a" canEdit />);
      await waitFor(() => expect(findRow("Kit Moss")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Record reply for Kit Moss" }));
      fireEvent.input(await screen.findByLabelText(/Anything else/i), {
        target: { value: "No shellfish" },
      });
      fireEvent.click(screen.getByLabelText(ORGANISER_PLUS_ONE_DIETARY_ATTESTATION.text));
      fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));

      expect(await screen.findByText(/This page is out of date/i)).toBeTruthy();
    },
  );

  for (const [what, presets, text, named] of [
    ["picked from the list", ["vegetarian"], "", "Vegetarian"],
    ["typed", [], "No shellfish", "No shellfish"],
    // Worded as the row's Dietary cell words it, so the note names what the
    // host can see.
    [
      "picked and typed",
      ["vegetarian", "other"],
      "No shellfish",
      "Vegetarian; Other; No shellfish",
    ],
  ] as const) {
    it(`says, naming them, that a save keeps requirements the household ${what}`, async () => {
      const view = withSamDietary([...presets], text);
      authFetchMock
        .mockResolvedValueOnce(json(view))
        .mockResolvedValueOnce(json(saved("p1", "maybe", "inviter_attested")));
      render(() => <RsvpView weddingId="wed_a" canEdit />);
      await waitFor(() => expect(findRow("Sam Lee")).toBeTruthy());

      fireEvent.click(screen.getByRole("button", { name: "Edit reply for Sam Lee" }));
      const note = await screen.findByText(/Saving without changing these/i);
      expect(note.textContent).toContain(named);
      // Save carries the note, so it is heard where the host decides.
      const described = describedText(screen.getByRole("button", { name: /Save reply/i }));
      expect(described).toContain(named);
      // The fields hold what the household gave, and nothing new is attested.
      expect((screen.getByLabelText(/Anything else/i) as HTMLTextAreaElement).value).toBe(text);
      expect(screen.queryByLabelText(/I confirm the plus-one consented/i)).toBeNull();

      fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: "maybe" } });
      fireEvent.click(screen.getByRole("button", { name: /Save reply/i }));
      await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
      expect(JSON.parse(authFetchMock.mock.calls[1]![1]?.body as string)).toEqual({
        status: "maybe",
      });
    });
  }

  it("marks a plus-one from an API that sends the link but not the name", async () => {
    authFetchMock.mockResolvedValueOnce(json(LINK_WITHOUT_NAME));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(findRow("Kit Moss")).toBeTruthy());
    expect(within(rowOf("Kit Moss")).getByText("Plus-one of another guest")).toBeTruthy();
  });

  it("offers the guest's wording, and none of the plus-one's, on an ordinary guest's row", async () => {
    authFetchMock.mockResolvedValueOnce(json(PLUS_ONE_VIEW));
    render(() => <RsvpView weddingId="wed_a" canEdit />);
    await waitFor(() => expect(findRow("Bo Jones")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: "Edit reply for Bo Jones" }));
    fireEvent.input(await screen.findByLabelText(/Anything else/i), {
      target: { value: "No shellfish" },
    });
    expect(screen.getByLabelText(/I confirm the guest consented/i)).toBeTruthy();
    expect(screen.queryByLabelText(/I confirm the plus-one consented/i)).toBeNull();
    expect(screen.queryByText(/Share our privacy notice/i)).toBeNull();
  });
});
