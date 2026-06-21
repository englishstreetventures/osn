// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RsvpView is the read-only in-dashboard RSVP summary: per event, a status tally
 * and the guests who responded (status + dietary). The OSN auth + api helpers are
 * stubbed; this asserts the grouped render, the counts, and the empty state.
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
        },
        {
          guestId: "g2",
          firstName: "Bo",
          lastName: "Jones",
          familyName: "Jones",
          familyCode: "JONES-KITE-77Q2",
          status: "declined" as const,
          dietary: "",
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
});
