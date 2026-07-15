// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * GuestTable lists a wedding's families + guests and, per family, copies a
 * ready-to-send invite message (link + that family's code) to the clipboard and
 * marks the family "shared". The OSN auth + api helpers + toasts + the guest-site
 * URL are stubbed; this asserts the copied text, the mark-shared POST, the
 * "Sent" indicator, and the clipboard-unavailable fallback.
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();
const toastSuccess = vi.fn();
const toastError = vi.fn();
const writeText = vi.fn<(t: string) => Promise<void>>();

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

vi.mock("../lib/osn", () => ({ CIRE_WEB_URL: "https://guests.test" }));

const downloadBlobMock = vi.fn();
vi.mock("../lib/download", () => ({
  downloadBlob: (name: string, blob: Blob) => downloadBlobMock(name, blob),
  downloadCsv: vi.fn(),
}));

import { __resetEventsCache } from "../lib/events-store";
import { __resetGuestsCache } from "../lib/guests-store";
import GuestTable from "./GuestTable";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const GUESTS = [
  {
    familyId: "fam_a",
    publicId: "SHARMA-WIDGET-AB3K9-X7QPM",
    familyName: "Sharma",
    firstName: "Ada",
    lastName: "Sharma",
    events: ["evt_1"],
    codeSharedAt: null,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
  {
    familyId: "fam_b",
    publicId: "JONES-KITE-77Q2",
    familyName: "Jones",
    firstName: "Bo",
    lastName: "Jones",
    events: [],
    codeSharedAt: 1_700_000_000_000,
    firstOpenedAt: null,
    deactivatedAt: null,
  },
];

const EVENTS = [{ id: "evt_1", name: "Ceremony", slug: "ceremony", sortOrder: 0 }];

/** Resolve the onMount guests + events + invite-customisation loads, in call
 *  order. The invite read supplies the optional custom message (here null, so
 *  the copied message uses the default prose). */
function primeLoad(inviteMessage: string | null = null) {
  authFetchMock
    .mockResolvedValueOnce(json(GUESTS))
    .mockResolvedValueOnce(json(EVENTS))
    .mockResolvedValueOnce(json({ inviteMessage }));
}

describe("GuestTable", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
    writeText.mockReset();
    downloadBlobMock.mockReset();
    // GuestTable reads guests + events from module-scoped caches (P-I3); clear
    // them so each test starts cold and its mocked fetch sequence is honoured.
    __resetGuestsCache();
    __resetEventsCache();
  });

  function withClipboard() {
    writeText.mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
  }

  it("copies the invite message with the link + family code and marks shared", async () => {
    withClipboard();
    primeLoad();
    // The best-effort mark-shared POST.
    authFetchMock.mockResolvedValueOnce(json({ familyId: "fam_a", codeSharedAt: 1 }));

    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    const copyButtons = screen.getAllByRole("button", { name: /Copy message/i });
    fireEvent.click(copyButtons[0]!);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]![0];
    expect(copied).toContain("Nadia & Sam");
    // Path-routed: the link carries the wedding slug in the PATH, not the bare
    // origin — so the message opens THIS wedding on the SSR'd guest site.
    expect(copied).toContain("https://guests.test/nadia-sam-abc123");
    expect(copied).toContain("SHARMA-WIDGET-AB3K9-X7QPM");

    // Fires the mark-shared POST for that family.
    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(
          (c) =>
            String(c[0]) ===
              "https://api.test/api/organiser/weddings/wed_a/families/fam_a/mark-shared" &&
            (c[1] as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("uses the host's custom message as the first line when one is set", async () => {
    withClipboard();
    primeLoad("Come celebrate with us in Goa!");
    authFetchMock.mockResolvedValueOnce(json({ familyId: "fam_a", codeSharedAt: 1 }));

    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /Copy message/i })[0]!);

    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const copied = writeText.mock.calls[0]![0];
    // The custom message replaces line 1; the URL + code are still appended on
    // their own lines beneath it (3-line shape).
    expect(copied).toBe(
      "Come celebrate with us in Goa!\nhttps://guests.test/nadia-sam-abc123\nSHARMA-WIDGET-AB3K9-X7QPM",
    );
  });

  it("downloads the RSVP CSV when the export button is clicked", async () => {
    primeLoad();
    const csv = "Family Code,Family Name\r\nSHARMA-WIDGET-AB3K9-X7QPM,Sharma";
    authFetchMock.mockResolvedValueOnce(
      new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } }),
    );

    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Download RSVPs/i }));

    // Hits the server-built CSV endpoint…
    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(
          (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/rsvps.csv",
        ),
      ).toBe(true),
    );
    // …and triggers a blob download with the slug-based filename.
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(downloadBlobMock.mock.calls[0]![0]).toBe("cire-rsvps-nadia-sam-abc123.csv");
    expect(downloadBlobMock.mock.calls[0]![1]).toBeInstanceOf(Blob);
  });

  it("downloads the guest-roster CSV when its export button is clicked", async () => {
    primeLoad();
    const csv = "Family Code,Family Name\r\nSHARMA-WIDGET-AB3K9-X7QPM,Sharma";
    authFetchMock.mockResolvedValueOnce(
      new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } }),
    );

    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Download guests/i }));

    // Hits the server-built CSV endpoint…
    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(
          (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/guests.csv",
        ),
      ).toBe(true),
    );
    // …and triggers a blob download with the slug-based filename.
    await waitFor(() => expect(downloadBlobMock).toHaveBeenCalledTimes(1));
    expect(downloadBlobMock.mock.calls[0]![0]).toBe("cire-guests-nadia-sam-abc123.csv");
    expect(downloadBlobMock.mock.calls[0]![1]).toBeInstanceOf(Blob);
  });

  it("surfaces an error toast when an export fails (no download)", async () => {
    primeLoad();
    authFetchMock.mockResolvedValueOnce(new Response("nope", { status: 500 })); // export fails

    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    fireEvent.click(screen.getByRole("button", { name: /Download guests/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0]![0]).toContain("Guest list export failed");
    expect(downloadBlobMock).not.toHaveBeenCalled();
  });

  it("shows a Sent indicator for an already-shared family", async () => {
    withClipboard();
    primeLoad();
    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Jones")).toBeTruthy());
    // fam_b (Jones) came back with a non-null codeSharedAt → "Sent" badge.
    expect(screen.getByText("Sent")).toBeTruthy();
    // Neither family has been opened, so no "Opened" badge anywhere.
    expect(screen.queryByText("Opened")).toBeNull();
  });

  it("shows no status badge for a family that is neither shared nor opened", async () => {
    withClipboard();
    primeLoad();
    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());
    // fam_a (Sharma): codeSharedAt null + firstOpenedAt null → nothing. The only
    // status badge present belongs to the (separately) shared Jones family.
    expect(screen.queryByText("Opened")).toBeNull();
  });

  it("shows an Opened badge (precedence over Sent) when a guest has opened the invite", async () => {
    withClipboard();
    // fam_b is BOTH shared and opened — "Opened" must win, "Sent" must not show.
    const opened = [GUESTS[0], { ...GUESTS[1], firstOpenedAt: 1_700_000_500_000 }];
    authFetchMock
      .mockResolvedValueOnce(json(opened))
      .mockResolvedValueOnce(json(EVENTS))
      .mockResolvedValueOnce(json({ inviteMessage: null }));
    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Jones")).toBeTruthy());

    expect(screen.getByText("Opened")).toBeTruthy();
    // Precedence: the opened family shows "Opened", not "Sent" — and no other
    // family is shared in this fixture, so "Sent" is absent entirely.
    expect(screen.queryByText("Sent")).toBeNull();
  });

  it("surfaces a manual-copy toast when the clipboard is unavailable", async () => {
    // No navigator.clipboard, and execCommand returns false.
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    (document as unknown as { execCommand: () => boolean }).execCommand = () => false;
    primeLoad();
    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /Copy message/i })[0]!);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
  });

  it("deactivates a family after confirm and mutes the row", async () => {
    primeLoad();
    // The deactivate POST.
    authFetchMock.mockResolvedValueOnce(
      json({ familyId: "fam_a", deactivatedAt: 1_700_000_900_000 }),
    );
    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    // Sharma (fam_a) is active → a Deactivate button is present.
    const deactivateBtn = screen.getAllByRole("button", { name: /^Deactivate$/i })[0]!;
    fireEvent.click(deactivateBtn);
    // Confirm step.
    const confirmBtn = await screen.findByRole("button", { name: /^Confirm$/i });
    fireEvent.click(confirmBtn);

    // Hits the deactivate endpoint…
    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(
          (c) =>
            String(c[0]) ===
              "https://api.test/api/organiser/weddings/wed_a/families/fam_a/deactivate" &&
            (c[1] as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
    // …and surfaces the "Deactivated — code disabled" label optimistically.
    await waitFor(() => expect(screen.getByText(/Deactivated — code disabled/i)).toBeTruthy());
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("reactivates an already-deactivated family directly (no confirm)", async () => {
    const deactivated = [{ ...GUESTS[0], deactivatedAt: 1_700_000_900_000 }, GUESTS[1]];
    authFetchMock
      .mockResolvedValueOnce(json(deactivated))
      .mockResolvedValueOnce(json(EVENTS))
      .mockResolvedValueOnce(json({ inviteMessage: null }))
      // The reactivate POST.
      .mockResolvedValueOnce(json({ familyId: "fam_a", deactivatedAt: null }));

    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());
    // fam_a starts deactivated → the label is shown + a Reactivate button exists.
    expect(screen.getByText(/Deactivated — code disabled/i)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /^Reactivate$/i }));

    await waitFor(() =>
      expect(
        authFetchMock.mock.calls.some(
          (c) =>
            String(c[0]) ===
              "https://api.test/api/organiser/weddings/wed_a/families/fam_a/reactivate" &&
            (c[1] as RequestInit | undefined)?.method === "POST",
        ),
      ).toBe(true),
    );
    // The label clears once reactivated.
    await waitFor(() => expect(screen.queryByText(/Deactivated — code disabled/i)).toBeNull());
    expect(toastSuccess).toHaveBeenCalled();
  });

  it("surfaces an inline error when deactivation fails", async () => {
    primeLoad();
    authFetchMock.mockResolvedValueOnce(json({ error: "boom" }, 500));
    render(() => (
      <GuestTable
        weddingId="wed_a"
        canManage
        weddingName="Nadia & Sam"
        weddingSlug="nadia-sam-abc123"
      />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /^Deactivate$/i })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: /^Confirm$/i }));

    await waitFor(() => expect(toastError).toHaveBeenCalled());
    // The row is NOT muted (no optimistic flip on failure).
    expect(screen.queryByText(/Deactivated — code disabled/i)).toBeNull();
  });
});
