// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ImportHistory fetches the import list when its disclosure is opened, renders a
 * human summary + status per entry, and offers a confirm-gated Revert on applied
 * entries that POSTs to the revert endpoint and refreshes. These tests drive that
 * behaviour against a mocked authFetch.
 */

const authFetchMock = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: vi.fn(),
}));

const invalidateEventsMock = vi.fn();
vi.mock("../lib/events-store", () => ({
  invalidateEvents: (id: string) => invalidateEventsMock(id),
}));

import ImportHistory from "./ImportHistory";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

const APPLIED_ENTRY = {
  id: "imp_applied",
  uploadedAt: 1_700_000_000_000,
  format: "csv",
  status: "applied" as const,
  appliedAt: 1_700_000_000_500,
  revertedAt: null,
  summary: { guestCreates: 12, guestRemoves: 2, eventUpdates: 3 },
};

const REVERTED_ENTRY = {
  id: "imp_reverted",
  uploadedAt: 1_699_000_000_000,
  format: "csv",
  status: "reverted" as const,
  appliedAt: 1_699_000_000_500,
  revertedAt: 1_699_000_001_000,
  summary: { guestCreates: 4 },
};

let confirmMock: ReturnType<typeof vi.fn>;
let reloadMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  // happy-dom doesn't implement window.confirm; define it as a mock (default: OK).
  confirmMock = vi.fn().mockReturnValue(true);
  Object.defineProperty(window, "confirm", { configurable: true, value: confirmMock });
  reloadMock = vi.fn();
  // happy-dom's location.reload is read-only; redefine it for the assertion.
  Object.defineProperty(window, "location", {
    configurable: true,
    value: { ...window.location, reload: reloadMock },
  });
});

afterEach(() => {
  cleanup();
  authFetchMock.mockReset();
  invalidateEventsMock.mockReset();
});

function openHistory() {
  const summary = [...document.querySelectorAll("details > summary")].find((s) =>
    /import history/i.test(s.textContent ?? ""),
  );
  expect(summary).toBeTruthy();
  // Opening the <details> is what the component listens for (onToggle); set the
  // open attribute then fire the toggle event the same way the browser would.
  const details = summary!.closest("details") as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event("toggle"));
}

describe("ImportHistory", () => {
  it("fetches and renders entries with a human summary + status when opened", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({ imports: [APPLIED_ENTRY, REVERTED_ENTRY], nextCursor: null }),
    );

    render(() => <ImportHistory weddingId="wed_a" />);
    openHistory();

    await waitFor(() => expect(document.body.textContent).toContain("+12 guests"));
    expect(authFetchMock.mock.calls[0]![0]).toContain("/api/organiser/weddings/wed_a/import/list");

    const body = document.body.textContent ?? "";
    expect(body).toContain("−2 guests");
    expect(body).toContain("3 events updated");
    expect(body).toContain("Applied");
    expect(body).toContain("Reverted");
  });

  it("offers Revert only on applied entries", async () => {
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({ imports: [APPLIED_ENTRY, REVERTED_ENTRY], nextCursor: null }),
    );

    render(() => <ImportHistory weddingId="wed_a" />);
    openHistory();

    await waitFor(() => expect(screen.getAllByRole("button", { name: /revert/i }).length).toBe(1));
  });

  it("reverts: confirms, POSTs the import id, invalidates events, reloads + refreshes list", async () => {
    authFetchMock
      .mockResolvedValueOnce(jsonResponse({ imports: [APPLIED_ENTRY], nextCursor: null }))
      .mockResolvedValueOnce(jsonResponse({ summary: { importId: "imp_applied" } }))
      .mockResolvedValueOnce(
        jsonResponse({
          imports: [{ ...APPLIED_ENTRY, status: "reverted", revertedAt: Date.now() }],
          nextCursor: null,
        }),
      );

    render(() => <ImportHistory weddingId="wed_a" />);
    openHistory();

    const revertBtn = await screen.findByRole("button", { name: /revert/i });
    fireEvent.click(revertBtn);

    await waitFor(() => expect(reloadMock).toHaveBeenCalledTimes(1));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    // Calls: list (open) → revert (POST) → list (refresh).
    expect(authFetchMock).toHaveBeenCalledTimes(3);
    const revertCall = authFetchMock.mock.calls[1]!;
    expect(revertCall[0]).toContain("/api/organiser/weddings/wed_a/import/revert");
    expect(revertCall[1]).toMatchObject({ method: "POST" });
    expect(JSON.parse((revertCall[1] as { body: string }).body)).toEqual({
      importId: "imp_applied",
    });
    expect(invalidateEventsMock).toHaveBeenCalledWith("wed_a");
  });

  it("does not POST when the user cancels the confirm", async () => {
    confirmMock.mockReturnValue(false);
    authFetchMock.mockResolvedValueOnce(
      jsonResponse({ imports: [APPLIED_ENTRY], nextCursor: null }),
    );

    render(() => <ImportHistory weddingId="wed_a" />);
    openHistory();

    const revertBtn = await screen.findByRole("button", { name: /revert/i });
    fireEvent.click(revertBtn);

    expect(confirmMock).toHaveBeenCalled();
    // Only the initial list fetch ran — no revert POST.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("surfaces an API error from revert inline", async () => {
    authFetchMock
      .mockResolvedValueOnce(jsonResponse({ imports: [APPLIED_ENTRY], nextCursor: null }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "No prior applied import to revert to" }, false, 409),
      );

    render(() => <ImportHistory weddingId="wed_a" />);
    openHistory();

    const revertBtn = await screen.findByRole("button", { name: /revert/i });
    fireEvent.click(revertBtn);

    await waitFor(() =>
      expect(document.body.textContent).toContain("No prior applied import to revert to"),
    );
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it("surfaces an error when the list fetch fails", async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, false, 500));

    render(() => <ImportHistory weddingId="wed_a" />);
    openHistory();

    await waitFor(() => expect(document.body.textContent).toContain("boom"));
  });

  it("renders an empty state when there are no imports", async () => {
    authFetchMock.mockResolvedValueOnce(jsonResponse({ imports: [], nextCursor: null }));

    render(() => <ImportHistory weddingId="wed_a" />);
    openHistory();

    await waitFor(() => expect(document.body.textContent).toContain("No imports yet."));
  });
});
