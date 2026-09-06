// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The events slice of the EventsEditor draft, on its own.
 *
 * `EventsEditor.test.tsx` replaces `invalidateEvents` with a spy so it can
 * assert which caches an apply invalidates. This case needs the real one — the
 * bug it covers is reached by an invalidate landing while the editor's own
 * load is in flight, and a spy bumps no generation. Hence a separate file
 * rather than a case in that one.
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
import { __resetEventsCache, invalidateEvents } from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

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
];

beforeEach(() => {
  __resetEventsCache();
  __resetGuestsCache();
  __resetHouseholdsCache();
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  __resetEventsCache();
  __resetGuestsCache();
  __resetHouseholdsCache();
});

// S-L (xchromo/osn-tracker#622). This editor deliberately seeds guests and
// households as empty, because its save posts `scope: "events"` and the server
// leaves those slices alone. That is exactly what makes the EVENTS slice
// dangerous: it is the one the server acts on, so a draft seeded from an empty
// events list reads as "delete every event". A generation-discarded load — an
// invalidate landing while the fetch is in flight, which is what a real
// save-then-refetch does — resolves `false` without filling the cache, and
// `?? []` used to turn that into exactly that draft.
it("shows a load error instead of seeding an empty draft when the events load resolves stale", async () => {
  let resolveEventsFetch!: (res: Response) => void;
  const eventsFetch = new Promise<Response>((resolve) => {
    resolveEventsFetch = resolve;
  });
  authFetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/events")) return eventsFetch;
    return Promise.resolve(json({}));
  });

  render(() => <EventsEditor weddingId="wed_a" />);

  // Wait until the fetch is actually issued: invalidating before
  // `ensureEventsLoaded` has read its starting generation is a different race.
  await waitFor(() =>
    expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/events"))).toBe(true),
  );

  invalidateEvents("wed_a");
  resolveEventsFetch(json(EVENTS));

  await waitFor(() => expect(screen.getByText(/Could not load the schedule/i)).toBeTruthy());
  expect(screen.queryByText("Ceremony")).toBeNull();
});
