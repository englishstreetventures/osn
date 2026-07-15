// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Overview is the module shell's home. It rolls up the shared caches (events +
 * guests) plus a settings + rsvps read into: a countdown to the wedding date,
 * RSVP totals across events, guests/schedule counts, and honest "coming soon"
 * snapshot cards for the Phase-1 planning modules (NO fabricated numbers — the
 * repo's no-mock-data rule). A brand-new wedding (no events, no guests) shows the
 * Getting-started checklist as its empty-state instead.
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

// GettingStarted fetches its own snapshot — stub it so this suite stays on the
// Overview's own glue rather than the checklist's fetches.
vi.mock("./GettingStarted", () => ({
  default: (p: { weddingId: string }) => <div data-testid="getting-started">{p.weddingId}</div>,
}));

import { __resetEventsCache } from "../lib/events-store";
import { __resetGuestsCache } from "../lib/guests-store";
import Overview from "./Overview";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Route the four Overview fetches (settings, rsvps, events, guests) by URL so
 *  the order the component fires them in doesn't matter. */
function routeFetch(opts: {
  settings?: unknown;
  rsvps?: unknown;
  events?: unknown;
  guests?: unknown;
}) {
  authFetchMock.mockImplementation((url: string) => {
    if (url.endsWith("/settings")) return Promise.resolve(json({ wedding: opts.settings ?? {} }));
    if (url.endsWith("/rsvps")) return Promise.resolve(json({ events: opts.rsvps ?? [] }));
    if (url.endsWith("/events")) return Promise.resolve(json(opts.events ?? []));
    if (url.endsWith("/guests")) return Promise.resolve(json(opts.guests ?? []));
    return Promise.resolve(json({}, 404));
  });
}

const GUESTS = [
  {
    familyId: "fam_a",
    publicId: "P1",
    familyName: "A",
    firstName: "Al",
    lastName: "A",
    events: ["e1"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
  {
    familyId: "fam_a",
    publicId: "P1",
    familyName: "A",
    firstName: "Bo",
    lastName: "A",
    events: ["e1"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
  {
    familyId: "fam_b",
    publicId: "P2",
    familyName: "B",
    firstName: "Cy",
    lastName: "B",
    events: ["e1"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];
const EVENTS = [{ id: "e1", name: "Ceremony" }];
const RSVPS = [
  { invited: 10, attending: 6, declined: 2, maybe: 1, responded: 9, noResponse: 1 },
  { invited: 8, attending: 4, declined: 1, maybe: 0, responded: 5, noResponse: 3 },
];

describe("Overview", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    __resetEventsCache();
    __resetGuestsCache();
  });

  it("shows the getting-started empty-state for a brand-new wedding", async () => {
    routeFetch({
      settings: { weddingDate: null, currency: "AUD", budgetTotalMinor: null },
      rsvps: [],
      events: [],
      guests: [],
    });
    render(() => <Overview weddingId="wed_1" onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("getting-started")).toBeTruthy());
    // No stat cards for an empty wedding — the checklist IS the home.
    expect(screen.queryByText(/attending across/i)).toBeNull();
  });

  it("renders a countdown, RSVP totals, and household/event counts once populated", async () => {
    // A future date so the countdown is a positive day count.
    const future = new Date();
    future.setDate(future.getDate() + 30);
    const iso = future.toISOString().slice(0, 10);
    routeFetch({
      settings: {
        weddingDate: iso,
        guestCountEstimate: 40,
        currency: "AUD",
        budgetTotalMinor: 5_000_00,
      },
      rsvps: RSVPS,
      events: EVENTS,
      guests: GUESTS,
    });
    render(() => <Overview weddingId="wed_1" onNavigate={vi.fn()} />);

    // Countdown: ~30 days out (allow ±1 for the local-midnight rounding boundary).
    await waitFor(() => expect(screen.getByText(/days to go/i)).toBeTruthy());
    // The day count is shown ONCE (a headline number + a "days to go" label) —
    // no second line repeating the same figure (product-owner de-dupe). The exact
    // count floats ±1 across the local-midnight boundary, so read whatever the
    // headline renders and assert no OTHER element on the page holds that same
    // bare number (the old markup printed it twice: a big "30" + "30 days to go").
    const headline = screen
      .getByText(/days to go/i)
      .closest("div")!
      .querySelector(".tabular-nums")!;
    const count = headline.textContent!.trim();
    expect(count).toMatch(/^\d+$/);
    // getAllByText(exact) matches only elements whose OWN text is exactly `count`.
    expect(screen.getAllByText(count, { exact: true })).toHaveLength(1);
    // RSVP roll-up: attending = 6 + 4 = 10 across 2 events.
    expect(screen.getByText(/attending across 2 events/i)).toBeTruthy();
    // Households deduped from the repeated-per-member rows: fam_a + fam_b = 2.
    const guestsCard = screen.getByText("Households").closest("div")!;
    expect(guestsCard.textContent).toContain("2");
  });

  it("prompts to set a date when none is set (no fabricated countdown)", async () => {
    routeFetch({
      settings: { weddingDate: null, currency: "AUD", budgetTotalMinor: null },
      rsvps: RSVPS,
      events: EVENTS,
      guests: GUESTS,
    });
    render(() => <Overview weddingId="wed_1" onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByText(/No date yet/i)).toBeTruthy());
    expect(screen.getByText(/Set your wedding date/i)).toBeTruthy();
  });

  it("renders the planning snapshots as honest 'coming soon' placeholders, not data", async () => {
    routeFetch({
      settings: { weddingDate: null, currency: "AUD", budgetTotalMinor: null },
      rsvps: RSVPS,
      events: EVENTS,
      guests: GUESTS,
    });
    render(() => <Overview weddingId="wed_1" onNavigate={vi.fn()} />);
    await waitFor(() => expect(screen.getByText("Checklist")).toBeTruthy());
    expect(screen.getByText("Budget")).toBeTruthy();
    // The placeholders read as "not built yet" — a "Soon" tag, never a number.
    expect(screen.getAllByText(/Soon/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText(/Coming soon/i).length).toBeGreaterThanOrEqual(1);
  });
});
