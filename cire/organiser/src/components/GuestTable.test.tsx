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
  },
];

const EVENTS = [{ id: "evt_1", name: "Ceremony", slug: "ceremony", sortOrder: 0 }];

/** Resolve the onMount guests+events loads, in call order. */
function primeLoad() {
  authFetchMock.mockResolvedValueOnce(json(GUESTS)).mockResolvedValueOnce(json(EVENTS));
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
      <GuestTable weddingId="wed_a" weddingName="Nadia & Sam" weddingSlug="nadia-sam-abc123" />
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

  it("downloads the RSVP CSV when the export button is clicked", async () => {
    primeLoad();
    const csv = "Family Code,Family Name\r\nSHARMA-WIDGET-AB3K9-X7QPM,Sharma";
    authFetchMock.mockResolvedValueOnce(
      new Response(csv, { status: 200, headers: { "Content-Type": "text/csv" } }),
    );

    render(() => (
      <GuestTable weddingId="wed_a" weddingName="Nadia & Sam" weddingSlug="nadia-sam-abc123" />
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

  it("shows a Sent indicator for an already-shared family", async () => {
    withClipboard();
    primeLoad();
    render(() => (
      <GuestTable weddingId="wed_a" weddingName="Nadia & Sam" weddingSlug="nadia-sam-abc123" />
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
      <GuestTable weddingId="wed_a" weddingName="Nadia & Sam" weddingSlug="nadia-sam-abc123" />
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
    authFetchMock.mockResolvedValueOnce(json(opened)).mockResolvedValueOnce(json(EVENTS));
    render(() => (
      <GuestTable weddingId="wed_a" weddingName="Nadia & Sam" weddingSlug="nadia-sam-abc123" />
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
      <GuestTable weddingId="wed_a" weddingName="Nadia & Sam" weddingSlug="nadia-sam-abc123" />
    ));
    await waitFor(() => expect(screen.getByText("Sharma")).toBeTruthy());

    fireEvent.click(screen.getAllByRole("button", { name: /Copy message/i })[0]!);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});
