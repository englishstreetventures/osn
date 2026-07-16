// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RsvpView is the in-dashboard RSVP summary: per event, a status tally and the
 * guests who responded (status + dietary + provenance badge). Editors also get a
 * record/edit affordance. The OSN auth + api helpers are stubbed; this asserts
 * the grouped render, the counts, the empty state, provenance badging, and the
 * organiser-record flow.
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

import RsvpView from "./RsvpView";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VIEW = {
  events: [
    {
      id: "evt_1",
      name: "Ceremony",
      invited: 4,
      attending: 2,
      declined: 1,
      maybe: 0,
      responded: 3,
      noResponse: 1,
      guests: [
        {
          guestId: "g1",
          firstName: "Ada",
          lastName: "Sharma",
          familyName: "Sharma",
          familyCode: "SHARMA-WIDGET-AB3K9",
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
      ],
      unresponded: [
        {
          guestId: "g3",
          firstName: "Cleo",
          lastName: "Jones",
          familyName: "Jones",
          familyCode: "JONES-KITE-77Q2",
        },
      ],
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
      unresponded: [],
    },
  ],
};

describe("RsvpView", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
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

    // The tally numbers are present (attending 2, no-reply 1, invited 4).
    const dl = ceremony.querySelector("dl")!;
    expect(dl.textContent).toContain("2");
    expect(dl.textContent).toContain("4");
  });

  it("shows a per-event empty note when no one has replied", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);

    await waitFor(() => expect(screen.getByText("Reception")).toBeTruthy());
    const reception = screen.getByText("Reception").closest("section")!;
    expect(within(reception).getByText(/No replies yet/i)).toBeTruthy();
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

  it("badges an organiser-entered reply distinctly from a guest-submitted one", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Bo Jones")).toBeTruthy());
    // Bo's row is organiser_attested → the provenance badge appears; Ada's
    // (guest) row does not carry it.
    expect(screen.getByText(/Organiser-entered/i)).toBeTruthy();
    expect(screen.getAllByText(/Organiser-entered/i)).toHaveLength(1);
  });

  it("does not show record/edit controls for a viewer (canEdit falsy)", async () => {
    authFetchMock.mockResolvedValueOnce(json(VIEW));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ada Sharma")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /^Edit$/i })).toBeNull();
    expect(screen.queryByText(/Record a reply for another guest/i)).toBeNull();
  });

  it("editor records a phone RSVP: PUTs consent-attested body and reloads", async () => {
    authFetchMock
      .mockResolvedValueOnce(json(VIEW)) // initial load
      .mockResolvedValueOnce(
        json({ rsvp: { status: "attending", consentSource: "organiser_attested" } }),
      ) // PUT
      .mockResolvedValueOnce(json(VIEW)); // reload after save
    render(() => <RsvpView weddingId="wed_a" canEdit />);

    await waitFor(() => expect(screen.getByText("Ada Sharma")).toBeTruthy());

    // Open the record list for an unresponded guest.
    fireEvent.click(screen.getByText(/Record a reply for another guest/i));
    fireEvent.click(screen.getByRole("button", { name: /Record/i }));

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

    await waitFor(() => expect(screen.getByText("Ada Sharma")).toBeTruthy());
    // Edit Ada's existing reply (first Edit button in the responded table).
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
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
});
