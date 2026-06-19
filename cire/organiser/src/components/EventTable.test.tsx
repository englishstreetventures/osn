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
  date: "2026-09-19",
  startAt: "2026-09-19T18:00:00+10:00",
  endAt: "2026-09-19T23:00:00+10:00",
  timezone: "Australia/Sydney",
  location: "The Grand Hall",
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
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("renders the event with an image upload field and the replace note", async () => {
    authFetchMock.mockResolvedValueOnce(json([EVENT]));
    render(() => <EventTable weddingId="wed_1" />);

    await waitFor(() => screen.getByText("Reception"));
    expect(screen.getByLabelText("Event image")).toBeTruthy();
    expect(screen.getByText(/uploading replaces the current one/i)).toBeTruthy();
  });

  it("POSTs the chosen file to the per-event image endpoint and shows the preview", async () => {
    authFetchMock.mockResolvedValueOnce(json([EVENT])); // initial load
    authFetchMock.mockResolvedValueOnce(
      json({ eventId: "evt_1", imageUrl: "/api/invite/cire-wedding/event/evt_1/image?v=abc" }),
    ); // upload

    const { container } = render(() => <EventTable weddingId="wed_1" />);
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

    const { container } = render(() => <EventTable weddingId="wed_1" />);
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
