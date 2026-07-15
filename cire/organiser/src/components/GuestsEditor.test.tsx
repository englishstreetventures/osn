// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * GuestsEditor is the interactive guest editor (E5): a household-grouped editable
 * list with a per-guest × per-event attendance matrix and a Save flow that posts
 * the whole draft as DesiredState to changes/preview, renders the shared preview,
 * then applies. Auth/api/toast are stubbed; the stores are reset per test.
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
import GuestsEditor from "./GuestsEditor";

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
    startAt: "2026-11-14T15:00+11:00",
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
    locationLat: null,
    locationLng: null,
    pricingRegion: null,
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

/** Prime the onMount events + guests loads (order-independent — the component
 *  requests both; each URL is matched below). */
function primeLoad() {
  authFetchMock.mockImplementation((url: string) => {
    if (String(url).endsWith("/events")) return Promise.resolve(json(EVENTS));
    if (String(url).endsWith("/guests")) return Promise.resolve(json(GUESTS));
    return Promise.resolve(json({}));
  });
}

describe("GuestsEditor", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    __resetGuestsCache();
    __resetEventsCache();
  });

  it("renders households with an attendance matrix column per event", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() =>
      expect((screen.getByLabelText("Household name") as HTMLInputElement).value).toBe("Sharma"),
    );
    // Guest name field + the event column header.
    expect(screen.getByDisplayValue("Ada")).toBeTruthy();
    expect(screen.getByText("Ceremony")).toBeTruthy();
    // The attendance checkbox for Ada × Ceremony is present + checked.
    const box = screen.getByRole("checkbox", { name: /Ada attends Ceremony/i });
    expect((box as HTMLInputElement).checked).toBe(true);
  });

  it("shows the sticky save bar only once an edit makes the draft dirty", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Save changes/i })).toBeNull();

    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "Adaeze" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());
  });

  it("blocks save with an inline error when a required name is blanked", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());

    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "" } });
    await waitFor(() => expect(screen.getByText(/First name is required/i)).toBeTruthy());
    const save = screen.getByRole("button", { name: /Save changes/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("runs the save flow: preview → shared modal → apply → toast", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());

    // Make an edit.
    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "Adaeze" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save changes/i })).toBeTruthy());

    // The preview POST returns a plan with a warning; then the apply POST; then
    // the reload (events + guests) — matched by URL in the impl below.
    authFetchMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.endsWith("/changes/preview")) {
        return Promise.resolve(
          json({
            changeId: "chg_1",
            baseRevision: "genesis",
            warnings: ["1 guest will keep their RSVPs (rename)."],
            plan: {
              eventCreates: [],
              eventUpdates: [{}],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [{}],
              guestRemoves: [],
              eventLinkCreates: [],
              eventLinkRemoves: [],
              warnings: ["1 guest will keep their RSVPs (rename)."],
            },
          }),
        );
      }
      if (u.endsWith("/changes/apply")) {
        return Promise.resolve(json({ summary: { importId: "chg_1" } }));
      }
      if (u.endsWith("/events")) return Promise.resolve(json(EVENTS));
      if (u.endsWith("/guests"))
        return Promise.resolve(json([{ ...GUESTS[0], firstName: "Adaeze" }]));
      return Promise.resolve(json({}));
    });

    fireEvent.click(screen.getByRole("button", { name: /Save changes/i }));

    // The shared preview modal appears with the diff + warning.
    await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
    expect(screen.getByText(/keep their RSVPs/i)).toBeTruthy();

    // Confirm apply (the modal's confirm button is labelled distinctly).
    fireEvent.click(screen.getByRole("button", { name: /Confirm & save/i }));

    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(
          (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/changes/apply",
        ),
      ).toBe(true),
    );
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    expect(toastSuccess.mock.calls[0]![0]).toMatch(/saved/i);

    // The apply call carried the previewed changeId.
    const applyCall = authFetchMock.mock.calls.find(
      (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/changes/apply",
    )!;
    expect(JSON.parse(String((applyCall[1] as RequestInit).body)).changeId).toBe("chg_1");
  });

  it("adds a household and a guest", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Add household/i }));
    // A new blank household field appears (the "New — code minted on save" badge).
    await waitFor(() => expect(screen.getByText(/code minted on save/i)).toBeTruthy());
  });

  it("surfaces a 409 as a re-preview prompt", async () => {
    primeLoad();
    render(() => <GuestsEditor weddingId="wed_a" />);
    await waitFor(() => expect(screen.getByDisplayValue("Ada")).toBeTruthy());
    fireEvent.input(screen.getByDisplayValue("Ada"), { target: { value: "Adaeze" } });
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
              eventUpdates: [],
              eventRemoves: [],
              familyCreates: [],
              familyRemoves: [],
              guestCreates: [],
              guestUpdates: [{}],
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
});
