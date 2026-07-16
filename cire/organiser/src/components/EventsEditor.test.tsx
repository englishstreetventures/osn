// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * EventsEditor is the interactive events editor (E6): a re-orderable event list
 * on the shared draft store, an add/edit drawer, delete-with-impact-confirm, and
 * a Save flow that posts the whole draft (events + guests) as DesiredState to
 * changes/preview, renders the shared preview, then applies. Auth/api/toast are
 * stubbed; the shared caches are reset per test.
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

import { __resetEventsCache } from "../lib/events-store";
import { __resetGuestsCache } from "../lib/guests-store";
import EventsEditor from "./EventsEditor";

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
    endAt: "",
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
  {
    id: "evt_2",
    name: "Reception",
    slug: "reception",
    sortOrder: 1,
    startAt: "2026-11-14T18:00:00+11:00",
    endAt: "",
    timezone: "Australia/Sydney",
    address: "The Grounds",
    description: "",
    dressCodeDescription: null,
    dressCodePalette: null,
    pinterestUrl: null,
    mapsUrl: null,
    imageUrl: null,
    imageCrop: null,
  },
];

const GUESTS = [
  {
    guestId: "g_1",
    familyId: "fam_a",
    publicId: "SHARMA-KITE-77Q2",
    familyName: "Sharma",
    firstName: "Ada",
    lastName: "Sharma",
    nickname: null,
    events: ["evt_1"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];

function primeLoad() {
  authFetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith("/events")) return Promise.resolve(json(EVENTS));
    if (String(url).endsWith("/guests")) return Promise.resolve(json(GUESTS));
    return Promise.resolve(json({}));
  });
}

beforeEach(() => {
  // happy-dom lacks window.confirm; default to OK.
  Object.defineProperty(window, "confirm", {
    configurable: true,
    value: vi.fn().mockReturnValue(true),
  });
});

describe("EventsEditor", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    __resetGuestsCache();
    __resetEventsCache();
  });

  it("renders the events in schedule order", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());
    expect(screen.getByText("Reception")).toBeTruthy();
  });

  it("opens the drawer and edits an event name", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    // Open the first event's drawer.
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() => expect(screen.getByRole("dialog", { name: /Edit event/i })).toBeTruthy());

    const nameField = screen.getByLabelText("Event name") as HTMLInputElement;
    expect(nameField.value).toBe("Ceremony");
    fireEvent.input(nameField, { target: { value: "Wedding Ceremony" } });

    // The edit makes the draft dirty ⇒ the sticky Save bar appears.
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());
  });

  it("blocks save with an inline drawer error when a required field is blanked", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() => expect(screen.getByLabelText("Event name")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Event name"), { target: { value: "" } });

    await waitFor(() => expect(screen.getByText(/Event name is required/i)).toBeTruthy());
    const save = screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("reorders an event with the move controls", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Reception")).toBeTruthy());

    // Move Reception up.
    fireEvent.click(screen.getByRole("button", { name: /Move Reception up/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    // First rendered event heading is now Reception.
    const headings = screen.getAllByText(/Ceremony|Reception/);
    expect(headings[0]!.textContent).toContain("Reception");
  });

  it("adds a new event via Add event", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Add event/i }));
    // A drawer opens for the new (blank) event, and a "New — saved on apply" badge shows.
    await waitFor(() => expect(screen.getByText(/saved on apply/i)).toBeTruthy());
  });

  it("runs the save flow: preview → shared modal → apply → toast", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Edit$/i })[0]!);
    await waitFor(() => expect(screen.getByLabelText("Event name")).toBeTruthy());
    fireEvent.input(screen.getByLabelText("Event name"), { target: { value: "Wedding Ceremony" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: ["1 event will be updated."],
            plan: {
              eventCreates: [],
              eventUpdates: [{}],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: ["1 event will be updated."],
            },
          }),
        );
      }
      if (u.endsWith("/changes/apply"))
        return Promise.resolve(json({ summary: { importId: "chg_1" } }));
      if (u.endsWith("/events"))
        return Promise.resolve(json([{ ...EVENTS[0], name: "Wedding Ceremony" }, EVENTS[1]]));
      if (u.endsWith("/guests")) return Promise.resolve(json(GUESTS));
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    // The shared preview modal appears with the warning.
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: /Review changes before applying/i })).toBeTruthy(),
    );
    expect(screen.getByText(/1 event will be updated/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Confirm & save/i }));

    await waitFor(() =>
      expect(authFetchMock.mock.calls.some((c) => String(c[0]).endsWith("/changes/apply"))).toBe(
        true,
      ),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0]![0]).toMatch(/saved/i);

    const applyCall = authFetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith("/changes/apply"),
    )!;
    expect(JSON.parse(String((applyCall[1] as RequestInit).body)).changeId).toBe("chg_1");
  });

  it("surfaces a 409 apply as a re-preview prompt", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Ceremony")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Move Reception up/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: [],
            plan: {
              eventCreates: [],
              eventUpdates: [{}, {}],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: [],
            },
          }),
        );
      }
      if (u.endsWith("/changes/apply"))
        return Promise.resolve(json({ error: "State changed — re-preview" }, 409));
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /Confirm & save/i }));

    await waitFor(() => expect(screen.getByText(/changed elsewhere/i)).toBeTruthy());
  });

  it("deletes an event after a confirm", async () => {
    primeLoad();
    render(() => <EventsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByText("Reception")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Delete$/i })[1]!);
    // Reception is gone from the list; the draft is dirty.
    await waitFor(() => expect(screen.queryByText("Reception")).toBeNull());
    expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy();
  });
});
