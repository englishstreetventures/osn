// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor, within } from "@solidjs/testing-library";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The RSVP table's "New" badges: rows a guest changed since this organiser last
 * opened the table carry one, and opening the table marks those changes seen
 * for this organiser only. The rest of RsvpView is tested in RsvpView.test.tsx.
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

const guest = (guestId: string, firstName: string) => ({
  guestId,
  firstName,
  lastName: "Test",
  familyName: "Test",
  familyCode: "TEST-CODE-1",
});

const VIEW = {
  events: ["evt_1", "evt_2"].map((id, i) => ({
    id,
    name: i === 0 ? "Ceremony" : "Reception",
    invited: 3,
    attending: 2,
    declined: 0,
    maybe: 0,
    responded: 2,
    noResponse: 1,
    guests: [
      {
        ...guest("g1", "Ada"),
        status: "attending",
        dietary: "",
        dietaryPresets: [],
        consentSource: "guest",
      },
      {
        ...guest("g2", "Bo"),
        status: "attending",
        dietary: "",
        dietaryPresets: [],
        consentSource: "guest",
      },
    ],
    unresponded: [guest("g3", "Cleo")],
  })),
};

const feed = (rows: { guestId: string; eventId: string | null }[], markSeq: number) => ({
  markSeq,
  rows,
});

function routeFetch(changes: unknown) {
  authFetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/rsvp-changes/seen")) return Promise.resolve(json({ seenSeq: 1 }));
    if (url.endsWith("/rsvp-changes/rows")) return Promise.resolve(json(changes));
    if (url.endsWith("/rsvps")) return Promise.resolve(json(VIEW));
    return Promise.resolve(json({}, 404));
  });
}

const section = (name: string) =>
  screen.getByRole("heading", { name }).closest("section") as HTMLElement;
const rowOf = (sectionName: string, firstName: string) =>
  within(section(sectionName))
    .getByText(new RegExp(`^${firstName} Test`))
    .closest("tr")!;
const seenCalls = () =>
  authFetchMock.mock.calls.filter(([url]) => String(url).endsWith("/rsvp-changes/seen"));

describe("RsvpView — New badges", () => {
  afterEach(() => {
    cleanup();
    resetOrganiserMocks();
  });

  it("badges exactly the rows the guest changed", async () => {
    routeFetch(feed([{ guestId: "g1", eventId: "evt_2" }], 5));
    render(() => <RsvpView weddingId="wed_a" />);
    await screen.findByRole("heading", { name: "Reception" });
    await waitFor(() => expect(within(rowOf("Reception", "Ada")).getByText("New")).toBeVisible());
    expect(within(rowOf("Ceremony", "Ada")).queryByText("New")).toBeNull();
    expect(within(rowOf("Reception", "Bo")).queryByText("New")).toBeNull();
  });

  it("badges every row of a guest whose change had no event", async () => {
    routeFetch(feed([{ guestId: "g2", eventId: null }], 5));
    render(() => <RsvpView weddingId="wed_a" />);
    await screen.findByRole("heading", { name: "Reception" });
    await waitFor(() => expect(within(rowOf("Ceremony", "Bo")).getByText("New")).toBeVisible());
    expect(within(rowOf("Reception", "Bo")).getByText("New")).toBeVisible();
  });

  it("marks the changes seen once the table has loaded", async () => {
    routeFetch(feed([{ guestId: "g1", eventId: "evt_1" }], 9));
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(seenCalls()).toHaveLength(1));
    expect(seenCalls()[0]![1]).toMatchObject({ method: "POST", body: JSON.stringify({ seq: 9 }) });
  });

  it("marks nothing when nothing is new", async () => {
    routeFetch(feed([], 0));
    render(() => <RsvpView weddingId="wed_a" />);
    await screen.findByRole("heading", { name: "Reception" });
    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(([url]) => String(url).endsWith("/rsvp-changes/rows")),
      ).toBe(true),
    );
    expect(seenCalls()).toEqual([]);
    expect(screen.queryByText("New")).toBeNull();
  });

  it("shows the table without badges when the change feed cannot be read", async () => {
    authFetchMock.mockImplementation((url: string) =>
      Promise.resolve(url.endsWith("/rsvps") ? json(VIEW) : json({ error: "boom" }, 500)),
    );
    render(() => <RsvpView weddingId="wed_a" />);
    await screen.findByRole("heading", { name: "Reception" });
    expect(screen.queryByText("New")).toBeNull();
    expect(seenCalls()).toEqual([]);
  });

  it("marks nothing seen when the RSVPs themselves fail to load", async () => {
    let feedAnswered = false;
    authFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/rsvp-changes/rows")) {
        feedAnswered = true;
        return Promise.resolve(json(feed([{ guestId: "g1", eventId: "evt_1" }], 9)));
      }
      if (url.endsWith("/rsvps")) return Promise.resolve(json({ error: "boom" }, 500));
      return Promise.resolve(json({ seenSeq: 9 }));
    });
    render(() => <RsvpView weddingId="wed_a" />);
    expect(await screen.findByText(/Could not load RSVPs/)).toBeInTheDocument();
    await waitFor(() => expect(feedAnswered).toBe(true));
    // Let the feed's promise chain settle before looking for the POST.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seenCalls()).toEqual([]);
  });

  it("marks nothing seen when the organiser is signed out", async () => {
    authFetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/rsvp-changes/rows")) {
        return Promise.resolve(json(feed([{ guestId: "g1", eventId: "evt_1" }], 9)));
      }
      if (url.endsWith("/rsvps")) return Promise.resolve(json({ error: "unauthorised" }, 401));
      return Promise.resolve(json({ seenSeq: 9 }));
    });
    render(() => <RsvpView weddingId="wed_a" />);
    await waitFor(() => expect(redirectSpy).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(seenCalls()).toEqual([]);
  });
});
