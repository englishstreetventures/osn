// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ChangeHistory (E6 rebrand of ImportHistory) fetches the change list from
 * `changes/list` when its disclosure opens, labels each entry by kind
 * ("Spreadsheet import" / "In-app edit"), offers a confirm-gated Revert only on
 * applied entries that still have a usable before-image (`revertable`), and
 * shows a non-revertable note on an applied entry whose restore point aged out.
 */

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("../../src/lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: vi.fn(),
}));

const invalidateEventsMock = vi.fn();
vi.mock("../../src/lib/events-store", () => ({
  invalidateEvents: (id: string) => invalidateEventsMock(id),
}));
const invalidateGuestsMock = vi.fn();
vi.mock("../../src/lib/guests-store", () => ({
  invalidateGuests: (id: string) => invalidateGuestsMock(id),
}));

import ChangeHistory from "../../src/components/ChangeHistory";
import { authFetchMock, resetOrganiserMocks } from "../test-support/mocks";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body } as unknown as Response;
}

const IMPORT_APPLIED = {
  id: "chg_import",
  uploadedAt: 1_700_000_000_000,
  format: "csv",
  status: "applied" as const,
  kind: "import" as const,
  appliedAt: 1_700_000_000_500,
  revertedAt: null,
  revertable: true,
  summary: { guestCreates: 12, guestRemoves: 2, eventUpdates: 3 },
};

const EDITOR_APPLIED = {
  id: "chg_editor",
  uploadedAt: 1_700_000_100_000,
  format: "json",
  status: "applied" as const,
  kind: "editor" as const,
  appliedAt: 1_700_000_100_500,
  revertedAt: null,
  revertable: true,
  summary: { eventCreates: 1 },
};

const EDITOR_AGED_OUT = {
  id: "chg_old",
  uploadedAt: 1_699_000_000_000,
  format: "json",
  status: "applied" as const,
  kind: "editor" as const,
  appliedAt: 1_699_000_000_500,
  revertedAt: null,
  revertable: false, // before-image pruned (E3 prune-beyond-10)
  summary: { guestCreates: 4 },
};

let confirmMock: ReturnType<typeof vi.fn>;
let reloadMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  confirmMock = vi.fn().mockReturnValue(true);
  Object.defineProperty(window, "confirm", { configurable: true, value: confirmMock });
  reloadMock = vi.fn();
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: reloadMock },
  });
});

afterEach(() => {
  cleanup();
  resetOrganiserMocks();
  invalidateEventsMock.mockReset();
  invalidateGuestsMock.mockReset();
});

function openHistory() {
  const summary = [...document.querySelectorAll("details > summary")].find((s) =>
    /change history/i.test(s.textContent ?? ""),
  );
  expect(summary).toBeTruthy();
  const details = summary!.closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("ChangeHistory", () => {
  it("fetches from changes/list and labels entries by kind", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({ imports: [IMPORT_APPLIED, EDITOR_APPLIED], nextCursor: null }),
    );

    render(() => <ChangeHistory weddingId="wed_a" />);
    openHistory();

    await waitFor(() => expect(document.body.textContent).toContain("+12 guests"));
    expect(authFetchMock.mock.calls[0]![0]).toContain("/api/organiser/weddings/wed_a/changes/list");

    const body = document.body.textContent ?? "";
    expect(body).toContain("Spreadsheet import");
    expect(body).toContain("In-app edit");
    expect(body).toContain("3 events updated");
  });

  it("summarises a rename-only editor save — not 'No changes'", async () => {
    // A household rename travels as `familyUpdates` alone; before the field was
    // read here, a rename-only change listed as "No changes" and could not be
    // told apart from a genuine no-op when picking a revert target. A legacy row
    // without the field (IMPORT_APPLIED) must still summarise from its other
    // counts.
    const RENAME_ONLY = {
      ...EDITOR_APPLIED,
      id: "chg_rename",
      summary: { familyUpdates: 1 },
    };
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({ imports: [RENAME_ONLY, IMPORT_APPLIED], nextCursor: null }),
    );

    render(() => <ChangeHistory weddingId="wed_a" />);
    openHistory();

    await waitFor(() => expect(document.body.textContent).toContain("1 families renamed"));
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("No changes");
    expect(body).toContain("+12 guests");
  });

  it("offers Revert on revertable applied entries and a note on aged-out ones", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({ imports: [EDITOR_APPLIED, EDITOR_AGED_OUT], nextCursor: null }),
    );

    render(() => <ChangeHistory weddingId="wed_a" />);
    openHistory();

    // One revertable entry ⇒ one Revert button; the aged-out one shows a note.
    await waitFor(() => expect(screen.getAllByRole("button", { name: /revert/i }).length).toBe(1));
    expect(document.body.textContent).toContain("Restore point no longer available");
  });

  it("reverts via changes/revert: confirms, POSTs the change id, invalidates + reloads", async () => {
    authFetchMock
      .mockResolvedValueOnce(jsonResponse({ imports: [EDITOR_APPLIED], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ summary: { importId: "chg_editor" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          imports: [{ ...EDITOR_APPLIED, status: "reverted", revertedAt: Date.now() }],
          nextCursor: null,
        }),
      );

    render(() => <ChangeHistory weddingId="wed_a" />);
    openHistory();

    await waitFor(() => expect(screen.getByRole("button", { name: /revert/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));

    await waitFor(() => expect(reloadMock).toHaveBeenCalled());
    expect(confirmMock).toHaveBeenCalled();
    // The revert POST hit the changes/revert endpoint with the change id.
    const revertCall = authFetchMock.mock.calls.find((c) =>
      String(c[0]).endsWith("/changes/revert"),
    )!;
    expect(revertCall).toBeTruthy();
    expect(JSON.parse(String((revertCall[1] as RequestInit).body)).changeId).toBe("chg_editor");
    expect(invalidateEventsMock).toHaveBeenCalledWith("wed_a");
    expect(invalidateGuestsMock).toHaveBeenCalledWith("wed_a");
  });

  it("does not revert when the confirm is declined", async () => {
    confirmMock.mockReturnValue(false);
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({ imports: [EDITOR_APPLIED], nextCursor: null }),
    );

    render(() => <ChangeHistory weddingId="wed_a" />);
    openHistory();
    await waitFor(() => expect(screen.getByRole("button", { name: /revert/i })).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: /revert/i }));

    // No second (revert) fetch fired.
    expect(authFetchMock.mock.calls.length).toBe(1);
    expect(reloadMock).not.toHaveBeenCalled();
  });
});
