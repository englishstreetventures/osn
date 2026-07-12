// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EventLocationsPanel edits each event's planning location (location is
 * EVENT-scoped — a wedding can span countries). It loads events through the
 * shared events-store cache, geocodes an event's sheet address server-side,
 * and PUTs per-event saves. Auth + api helpers + toasts are stubbed; this
 * asserts the per-event render, the lookup fill, the PUT body, the pair-rule
 * rejection, and the write-through to the shared cache.
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: (m: string) => toastSuccess(m), error: (m: string) => toastError(m) },
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

import { __resetEventsCache, eventsAccessor } from "../lib/events-store";
import type { EventRow } from "../lib/events-store";
import EventLocationsPanel from "./EventLocationsPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseEvent = {
  slug: "e",
  sortOrder: 0,
  startAt: "2027-03-20T15:00:00+11:00",
  endAt: "",
  timezone: "Australia/Sydney",
  description: "",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  imageUrl: null,
  imageCrop: null,
  locationLat: null,
  locationLng: null,
  pricingRegion: null,
};

const EVENTS: EventRow[] = [
  { ...baseEvent, id: "evt_syd", name: "Reception", address: "Sydney NSW" },
  { ...baseEvent, id: "evt_jai", name: "Ceremony", address: "Jaipur, Rajasthan" },
  { ...baseEvent, id: "evt_bare", name: "Recovery brunch", address: null },
];

describe("EventLocationsPanel", () => {
  beforeEach(() => {
    __resetEventsCache();
  });
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  async function renderLoaded() {
    authFetchMock.mockResolvedValueOnce(json(EVENTS));
    render(() => <EventLocationsPanel weddingId="wed_1" />);
    await waitFor(() => expect(screen.getByText("Reception")).toBeTruthy());
  }

  it("renders one editor row per event with the sheet address", async () => {
    await renderLoaded();
    expect(screen.getByText("Ceremony")).toBeTruthy();
    expect(screen.getByText("Sydney NSW")).toBeTruthy();
    expect(screen.getByText("Jaipur, Rajasthan")).toBeTruthy();
    expect(screen.getByText("No address on the events sheet")).toBeTruthy();
    // Look up is disabled for the address-less event only.
    const lookups = screen.getAllByText("Look up") as HTMLButtonElement[];
    expect(lookups).toHaveLength(3);
    expect(lookups.filter((b) => b.disabled)).toHaveLength(1);
  });

  it("fills coordinates + region from a lookup of the event's address", async () => {
    await renderLoaded();
    authFetchMock.mockResolvedValueOnce(
      json({
        status: "ok",
        point: { lat: 26.9124, lng: 75.7873, formattedAddress: "Jaipur, Rajasthan, India" },
        pricingRegion: "international",
      }),
    );
    const lookups = screen.getAllByText("Look up");
    fireEvent.click(lookups[1]!); // Ceremony (Jaipur)

    await waitFor(() => expect(screen.getByText(/Matched: Jaipur/)).toBeTruthy());
    const [url, init] = authFetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/settings/geocode");
    expect(JSON.parse(String(init.body))).toEqual({ query: "Jaipur, Rajasthan" });

    const lats = screen.getAllByLabelText("Latitude") as HTMLInputElement[];
    expect(lats[1]!.value).toBe("26.9124");
    const regions = screen.getAllByLabelText("Region") as HTMLSelectElement[];
    expect(regions[1]!.value).toBe("international");
  });

  it("saves a location and writes through the shared cache", async () => {
    await renderLoaded();
    const lats = screen.getAllByLabelText("Latitude") as HTMLInputElement[];
    const lngs = screen.getAllByLabelText("Longitude") as HTMLInputElement[];
    fireEvent.input(lats[0]!, { target: { value: "-33.8688" } });
    fireEvent.input(lngs[0]!, { target: { value: "151.2093" } });
    const regions = screen.getAllByLabelText("Region") as HTMLSelectElement[];
    fireEvent.change(regions[0]!, { target: { value: "au-nsw" } });

    authFetchMock.mockResolvedValueOnce(
      json({
        event: {
          eventId: "evt_syd",
          locationLat: -33.8688,
          locationLng: 151.2093,
          pricingRegion: "au-nsw",
        },
      }),
    );
    fireEvent.click(screen.getAllByText("Save")[0]!);

    await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith("Location saved for Reception"));
    const [url, init] = authFetchMock.mock.calls[1] as [string, RequestInit];
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/events/evt_syd/location");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body))).toEqual({
      locationLat: -33.8688,
      locationLng: 151.2093,
      pricingRegion: "au-nsw",
    });
    // Write-through: the shared events cache now carries the saved location.
    const cached = eventsAccessor("wed_1")()!.find((e) => e.id === "evt_syd")!;
    expect(cached.locationLat).toBe(-33.8688);
    expect(cached.pricingRegion).toBe("au-nsw");
  });

  it("rejects a half coordinate client-side without a request", async () => {
    await renderLoaded();
    const lats = screen.getAllByLabelText("Latitude") as HTMLInputElement[];
    fireEvent.input(lats[0]!, { target: { value: "-33.8" } });
    fireEvent.click(screen.getAllByText("Save")[0]!);

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toContain("both a latitude and a longitude");
    expect(authFetchMock).toHaveBeenCalledTimes(1); // just the initial GET
  });

  it("hides the lookup buttons once the geocoder reports unavailable", async () => {
    await renderLoaded();
    authFetchMock.mockResolvedValueOnce(json({ status: "unavailable" }));
    fireEvent.click(screen.getAllByText("Look up")[0]!);

    await waitFor(() =>
      expect(screen.getByText(/Address lookup isn.t available right now/)).toBeTruthy(),
    );
    expect(screen.queryByText("Look up")).toBeNull();
  });

  it("renders nothing while the wedding has no events", async () => {
    authFetchMock.mockResolvedValueOnce(json([]));
    const { container } = render(() => <EventLocationsPanel weddingId="wed_1" />);
    await waitFor(() => expect(authFetchMock).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
