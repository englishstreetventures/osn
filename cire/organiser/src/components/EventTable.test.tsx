// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * EventTable lists the wedding's events (read-only details from the spreadsheet
 * import) and lets the organiser attach ONE image per event — upload (replace)
 * and remove. The OSN auth + api helpers + toasts are stubbed; this asserts the
 * per-event image wiring hits the right endpoints and updates the preview.
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

const downloadBlobMock = vi.fn();
vi.mock("../lib/download", () => ({
  downloadBlob: (name: string, blob: Blob) => downloadBlobMock(name, blob),
  downloadCsv: vi.fn(),
}));

import { __resetEventsCache, invalidateEvents } from "../lib/events-store";
import EventTable from "./EventTable";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const EVENT = {
  id: "evt_1",
  name: "Reception",
  slug: "reception",
  sortOrder: 0,
  startAt: "2026-09-19T18:00:00+10:00",
  endAt: "2026-09-19T23:00:00+10:00",
  timezone: "Australia/Sydney",
  address: null,
  description: "Dinner and dancing",
  dressCodeDescription: null,
  dressCodePalette: null,
  pinterestUrl: null,
  mapsUrl: null,
  imageUrl: null as string | null,
};

describe("EventTable per-event image", () => {
  afterEach(() => {
    cleanup();
    __resetEventsCache();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("renders the event with an image upload field and the replace note", async () => {
    authFetchMock.mockResolvedValueOnce(json([EVENT]));
    render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);

    await waitFor(() => screen.getByText("Reception"));
    expect(screen.getByLabelText("Event image")).toBeTruthy();
    expect(screen.getByText(/replaces the current one/i)).toBeTruthy();
  });

  it("POSTs the chosen file to the per-event image endpoint and shows the preview", async () => {
    authFetchMock.mockResolvedValueOnce(json([EVENT])); // initial load
    authFetchMock.mockResolvedValueOnce(
      json({ eventId: "evt_1", imageUrl: "/api/invite/cire-wedding/event/evt_1/image?v=abc" }),
    ); // upload

    const { container } = render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Reception"));

    const input = screen.getByLabelText("Event image") as HTMLInputElement;
    const file = new File([new Uint8Array([0x89, 0x50])], "x.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = authFetchMock.mock.calls[1];
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/events/evt_1/image");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(file);

    // Preview thumbnail appears, prefixed with the API origin.
    await waitFor(() => {
      const img = container.querySelector("img") as HTMLImageElement | null;
      expect(img?.getAttribute("src")).toBe(
        "https://api.test/api/invite/cire-wedding/event/evt_1/image?v=abc",
      );
    });
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("DELETEs the event image and clears the preview", async () => {
    authFetchMock.mockResolvedValueOnce(
      json([{ ...EVENT, imageUrl: "/api/invite/cire-wedding/event/evt_1/image?v=abc" }]),
    ); // initial load WITH an image
    authFetchMock.mockResolvedValueOnce(json({ eventId: "evt_1", imageUrl: null })); // delete

    const { container } = render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Reception"));
    // The preview + Remove button are present.
    expect(container.querySelector("img")).not.toBeNull();

    fireEvent.click(screen.getByText("Remove"));

    await waitFor(() => expect(authFetchMock).toHaveBeenCalledTimes(2));
    const [url, init] = authFetchMock.mock.calls[1];
    expect(url).toBe("https://api.test/api/organiser/weddings/wed_1/events/evt_1/image");
    expect(init.method).toBe("DELETE");

    await waitFor(() => expect(container.querySelector("img")).toBeNull());
    expect(toastSuccess).toHaveBeenCalled();
  });
});

/**
 * Events are cached per wedding (`../lib/events-store`) so the dashboard tabs
 * unmounting/remounting EventTable on a Guests ↔ Events switch don't re-issue
 * the `GET …/events` request. These assert the cache contract: dedupe across
 * remounts of the same wedding, refetch on a wedding change, and refetch after
 * an import apply invalidates the entry. The GET is `authFetch` call #0 in each
 * mount, so counting `authFetch` calls counts the fetch.
 */
describe("EventTable events caching", () => {
  afterEach(() => {
    cleanup();
    __resetEventsCache();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("does NOT re-fetch events when the tab switches back (remount, same wedding)", async () => {
    // Only ONE events response is queued — a second fetch would reject (no mock
    // value left) and the test would fail, proving the remount was served from
    // cache.
    authFetchMock.mockResolvedValueOnce(json([EVENT]));

    // First mount (Events tab) — fetches.
    const first = render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Reception"));
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    // Switch away to another tab: <Show> unmounts EventTable.
    first.unmount();

    // Switch back to Events: EventTable remounts. It must reuse the cache, not
    // refetch — call count stays at 1.
    render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Reception"));
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    // Rows render immediately from cache (no skeleton-then-data round trip).
    expect(screen.getByText("Reception")).toBeTruthy();
  });

  it("DOES fetch again when the selected wedding changes", async () => {
    authFetchMock.mockResolvedValueOnce(json([EVENT])); // wed_1
    authFetchMock.mockResolvedValueOnce(
      json([{ ...EVENT, id: "evt_2", name: "Ceremony", slug: "ceremony" }]),
    ); // wed_2

    const first = render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Reception"));
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    // A different wedding is a different cache key → a fresh fetch.
    render(() => <EventTable weddingId="wed_2" weddingSlug="my-other-wedding" />);
    await waitFor(() => screen.getByText("Ceremony"));
    expect(authFetchMock).toHaveBeenCalledTimes(2);
    expect(authFetchMock.mock.calls[1][0]).toBe(
      "https://api.test/api/organiser/weddings/wed_2/events",
    );
  });

  it("DOES re-fetch after an import apply invalidates the wedding's events", async () => {
    authFetchMock.mockResolvedValueOnce(json([EVENT])); // initial load
    authFetchMock.mockResolvedValueOnce(
      json([EVENT, { ...EVENT, id: "evt_2", name: "Ceremony", slug: "ceremony" }]),
    ); // post-import load (a new event was added)

    const first = render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Reception"));
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    first.unmount();

    // Simulate the ImportPanel apply flow's cache invalidation.
    invalidateEvents("wed_1");

    // Next mount must refetch (cache was dropped) and show the newly imported
    // event.
    render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Ceremony"));
    expect(authFetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The Events tab's "Download events (CSV)" button — the CSV is built (and
 * formula-sanitised) server-side at `GET …/events.csv`; the component only hands
 * the response Blob to the shared download helper. Mirrors GuestTable's export
 * tests.
 */
describe("EventTable events CSV export", () => {
  afterEach(() => {
    cleanup();
    __resetEventsCache();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    downloadBlobMock.mockReset();
  });

  it("downloads the server-built events CSV with a slug-based filename", async () => {
    authFetchMock.mockResolvedValueOnce(json([EVENT])); // initial load
    authFetchMock.mockResolvedValueOnce(
      new Response("Event Name,Slug\r\nReception,reception", {
        status: 200,
        headers: { "Content-Type": "text/csv; charset=utf-8" },
      }),
    ); // export

    render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Reception"));

    fireEvent.click(screen.getByRole("button", { name: /Download events/i }));

    // Hits the server-built CSV endpoint…
    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(
          (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_1/events.csv",
        ),
      ).toBe(true),
    );
    // …and triggers a blob download with the slug-based filename.
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(downloadBlobMock.mock.calls[0]![0]).toBe("cire-events-my-wedding.csv");
    expect(downloadBlobMock.mock.calls[0]![1]).toBeInstanceOf(Blob);
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("surfaces an error toast when the export fails", async () => {
    authFetchMock.mockResolvedValueOnce(json([EVENT])); // initial load
    authFetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 })); // export fails

    render(() => <EventTable weddingId="wed_1" weddingSlug="my-wedding" />);
    await waitFor(() => screen.getByText("Reception"));

    fireEvent.click(screen.getByRole("button", { name: /Download events/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });
});
