// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
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
import {
  __resetEventsCache,
  ensureEventsLoaded,
  invalidateEvents,
  patchCachedEvent,
} from "../../src/lib/events-store";
import { __resetGuestsCache } from "../../src/lib/guests-store";
import { __resetHouseholdsCache } from "../../src/lib/households-store";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The change head each editor reads before it loads its rows. */
const HEAD = "rev_head";

/** What an unrouted request gets: the change head for `/changes/head`, else `{}`. */
function fallback(url: unknown) {
  return String(url).endsWith("/changes/head") ? json({ revision: HEAD }) : json({});
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

// This editor deliberately seeds guests and households as empty, because its
// save posts `scope: "events"` and the server leaves those slices alone. That
// is exactly what makes the EVENTS slice dangerous: it is the one the server
// acts on, so a draft seeded from an empty events list reads as "delete every
// event". A generation-discarded load — an invalidate landing while the fetch
// is in flight, which is what a real save-then-refetch does — resolves
// `false` without filling the cache, and the loader treats that as a load
// failure rather than letting `?? []` silently seed the draft with it.
it("shows a load error instead of seeding an empty draft when the events load resolves stale", async () => {
  let resolveEventsFetch!: (res: Response) => void;
  const eventsFetch = new Promise<Response>((resolve) => {
    resolveEventsFetch = resolve;
  });
  authFetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/events")) return eventsFetch;
    return Promise.resolve(fallback(url));
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

// The draft carries the change head read BEFORE its rows, so rows cached before
// that read — by the schedule table, say — must not seed it: they could lack an
// event a co-host added, which the save would read as a removal while the head
// already counted it.
it("loads the schedule fresh after the head, even with a warm cache", async () => {
  await ensureEventsLoaded("wed_a", async () => [{ ...EVENTS[0]!, name: "Stale Ceremony" }]);
  authFetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
    return Promise.resolve(fallback(url));
  });

  render(() => <EventsEditor weddingId="wed_a" />);

  await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
  expect(screen.queryByText("Stale Ceremony")).toBeNull();
  const urls = authFetchMock.mock.calls.map((c) => String(c[0]));
  expect(urls.findIndex((u) => u.endsWith("/changes/head"))).toBeLessThan(
    urls.findIndex((u) => u.endsWith("/events")),
  );
});

// A later visit reuses the events read after the head the editor last read,
// drawing at once, and checks the head only once drawn.
it("reopens on the events it read after the head, sending nothing before they are drawn", async () => {
  authFetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
    return Promise.resolve(fallback(url));
  });
  const first = render(() => <EventsEditor weddingId="wed_a" />);
  await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
  first.unmount();
  authFetchMock.mockClear();

  render(() => <EventsEditor weddingId="wed_a" />);
  expect(screen.getByText("Ceremony")).toBeTruthy();
  expect(authFetchMock).not.toHaveBeenCalled();
  await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(1));
  expect(String(authFetchMock.mock.calls[0]![0])).toMatch(/\/changes\/head$/);
});

// An event image changed in the schedule table since: the cached array is not
// the one read after the head, so nothing vouches for its age.
it("reads the schedule again when the cached events changed since the head was read", async () => {
  authFetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
    return Promise.resolve(fallback(url));
  });
  const first = render(() => <EventsEditor weddingId="wed_a" />);
  await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
  first.unmount();
  patchCachedEvent("wed_a", EVENTS[0]!.id, { imageUrl: "/img.jpg" });
  authFetchMock.mockClear();

  render(() => <EventsEditor weddingId="wed_a" />);
  await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
  const urls = authFetchMock.mock.calls.map((c) => String(c[0]));
  expect(urls.findIndex((u) => u.endsWith("/changes/head"))).toBeLessThan(
    urls.findIndex((u) => u.endsWith("/events")),
  );
  expect(urls.some((u) => u.endsWith("/events"))).toBe(true);
});

/** Open the editor once so its events are cached under a recorded head, then
 *  unmount it; the next mount reopens on those rows. */
async function openOnceAndClose() {
  authFetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
    return Promise.resolve(fallback(url));
  });
  const first = render(() => <EventsEditor weddingId="wed_a" />);
  await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
  first.unmount();
  authFetchMock.mockClear();
}

/** Route the next `/changes/head` read to a promise the test answers; every
 *  later request gets `fallback` (and `/events` the schedule). */
function holdHead() {
  const held: { answer?: (res: Response) => void } = {};
  authFetchMock.mockImplementation((url: string) => {
    const u = String(url);
    if (u.endsWith("/changes/head") && !held.answer) {
      return new Promise<Response>((resolve) => {
        held.answer = resolve;
      });
    }
    if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
    return Promise.resolve(fallback(url));
  });
  return held;
}

it("keeps the edits and says the schedule is stale when the head moved under a dirty draft", async () => {
  await openOnceAndClose();
  const head = holdHead();

  render(() => <EventsEditor weddingId="wed_a" />);
  fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
  await waitFor(() => expect(screen.getByRole("dialog", { name: /Edit event/i })).toBeTruthy());
  fireEvent.input(screen.getByLabelText("Event name"), { target: { value: "Wedding Ceremony" } });
  await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(1));
  head.answer!(json({ revision: "rev_moved" }));

  await waitFor(() =>
    expect(
      screen.getByText("Someone else changed the schedule since you opened the editor."),
    ).toBeTruthy(),
  );
  expect(screen.getByDisplayValue("Wedding Ceremony")).toBeTruthy();
  // The edits stay: the schedule is not read again to replace them.
  expect(authFetchMock).toHaveBeenCalledTimes(1);
});

it("keeps a rename made while the moved head's events are read, with the drawer still open", async () => {
  await openOnceAndClose();
  // A co-host added the Reception since the events were cached.
  const reception = { ...EVENTS[0]!, id: "evt_2", name: "Reception", slug: "reception" };
  let releaseEvents!: () => void;
  const eventsHeld = new Promise<void>((resolve) => (releaseEvents = resolve));
  const posted: Record<string, unknown>[] = [];
  authFetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/changes/head")) return json({ revision: "rev_moved" });
    if (u.endsWith("/events")) {
      await eventsHeld;
      return json([...EVENTS, { ...reception, sortOrder: 1 }]);
    }
    if (u.endsWith("/changes/preview")) {
      posted.push(JSON.parse(String(init?.body)));
      return json({ error: "stop here" }, 500);
    }
    return fallback(url);
  });

  render(() => <EventsEditor weddingId="wed_a" />);
  await waitFor(() =>
    expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/events"))).toBe(true),
  );
  fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
  await waitFor(() => expect(screen.getByRole("dialog", { name: /Edit event/i })).toBeTruthy());
  fireEvent.input(screen.getByLabelText("Event name"), { target: { value: "Wedding Ceremony" } });
  // Save waits for the events: a save now would start a second reload beside them.
  const working = await waitFor(
    () => screen.getByRole("button", { name: "Working…" }) as HTMLButtonElement,
  );
  expect(working.disabled).toBe(true);

  releaseEvents();
  await waitFor(() => expect(screen.getByText("Reception")).toBeTruthy());
  // The drawer stays on the event being renamed, with the rename in it.
  expect(screen.getByRole("dialog", { name: /Edit event/i })).toBeTruthy();
  expect((screen.getByLabelText("Event name") as HTMLInputElement).value).toBe("Wedding Ceremony");
  expect(
    screen.queryByText("Someone else changed the schedule since you opened the editor."),
  ).toBeNull();

  fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
  await waitFor(() => expect(posted).toHaveLength(1));
  expect(posted[0]!.baseRevision).toBe("rev_moved");
  const wire = posted[0]!.desiredState as { events: { name: string }[] };
  expect(wire.events.map((e) => e.name)).toEqual(["Wedding Ceremony", "Reception"]);
});

it("stops showing a cached schedule when the head is refused once drawn", async () => {
  await openOnceAndClose();
  // The seat lost its edit rights: the editor-only head is refused.
  authFetchMock.mockImplementation(async (url: string) =>
    String(url).endsWith("/changes/head") ? json({ error: "Forbidden" }, 403) : fallback(url),
  );

  render(() => <EventsEditor weddingId="wed_a" />);
  expect(screen.getByText("Ceremony")).toBeTruthy();
  await waitFor(() => expect(screen.queryByText("Ceremony")).toBeNull());
  expect(
    screen.getByText(
      "You can no longer edit the schedule. Reload the page to see your current access.",
    ),
  ).toBeTruthy();
});

it("reads nothing more when the editor closed before the head answered", async () => {
  await openOnceAndClose();
  const head = holdHead();

  const second = render(() => <EventsEditor weddingId="wed_a" />);
  await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(1));
  second.unmount();
  head.answer!(json({ revision: "rev_moved" }));
  await new Promise((r) => setTimeout(r, 20));

  expect(authFetchMock).toHaveBeenCalledTimes(1);
});
