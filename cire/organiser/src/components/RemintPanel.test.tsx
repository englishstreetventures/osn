// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * RemintPanel re-mints every family code onto a chosen style. It warns when
 * families have already been sent their codes and requires an explicit confirm
 * before firing the destructive POST. The OSN auth + api helpers + toasts are
 * stubbed; this asserts the warning count, the confirm gate, and the request.
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

import RemintPanel from "./RemintPanel";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// Two families; one already shared (Jones), one not (Sharma). Guest rows repeat
// per member — the panel dedupes by familyId.
const GUESTS = [
  { familyId: "fam_a", publicId: "SHARMA-WIDGET-AB3K9-X7QPM", codeSharedAt: null },
  { familyId: "fam_a", publicId: "SHARMA-WIDGET-AB3K9-X7QPM", codeSharedAt: null },
  { familyId: "fam_b", publicId: "JONES-KITE-77Q2", codeSharedAt: 1_700_000_000_000 },
];

describe("RemintPanel", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastSuccess.mockReset();
    toastError.mockReset();
  });

  it("warns about already-sent families and re-mints on confirm", async () => {
    authFetchMock.mockResolvedValueOnce(json(GUESTS)); // onMount guest-count load
    render(() => <RemintPanel weddingId="wed_a" />);

    // Re-mint button enables once the count loads (2 families).
    const remintBtn = await waitFor(() => {
      const btn = screen.getByRole("button", { name: /Re-mint all codes/i });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
      return btn;
    });
    fireEvent.click(remintBtn);

    // Warning names the one already-shared family.
    await waitFor(() =>
      expect(screen.getByText(/1 family has already been sent their code/i)).toBeTruthy(),
    );

    // Confirm fires the destructive POST with the chosen style.
    authFetchMock.mockResolvedValueOnce(json({ codeStyle: "simple", reminted: 2 }));
    fireEvent.click(screen.getByRole("button", { name: /Yes, re-mint/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const remintCall = authFetchMock.mock.calls.find(
      (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/remint",
    );
    expect(remintCall).toBeTruthy();
    expect((remintCall![1] as RequestInit).method).toBe("POST");
    expect(JSON.parse(String((remintCall![1] as RequestInit).body))).toEqual({
      codeStyle: "simple",
    });
  });

  it("does not POST until the organiser confirms", async () => {
    authFetchMock.mockResolvedValueOnce(json(GUESTS));
    render(() => <RemintPanel weddingId="wed_a" />);

    const remintBtn = await waitFor(() => {
      const btn = screen.getByRole("button", { name: /Re-mint all codes/i });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
      return btn;
    });
    fireEvent.click(remintBtn);
    await waitFor(() => expect(screen.getByRole("button", { name: /Yes, re-mint/i })).toBeTruthy());

    // Only the onMount GET so far — no remint POST.
    expect(
      authFetchMock.mock.calls.some(
        (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/remint",
      ),
    ).toBe(false);
  });

  it("sends the chosen 'secure' style when selected", async () => {
    authFetchMock.mockResolvedValueOnce(json(GUESTS));
    render(() => <RemintPanel weddingId="wed_a" />);
    await waitFor(() => {
      const btn = screen.getByRole("button", { name: /Re-mint all codes/i });
      expect((btn as HTMLButtonElement).disabled).toBe(false);
    });

    fireEvent.click(screen.getByRole("radio", { name: /Secure/i }));
    fireEvent.click(screen.getByRole("button", { name: /Re-mint all codes/i }));
    authFetchMock.mockResolvedValueOnce(json({ codeStyle: "secure", reminted: 2 }));
    fireEvent.click(screen.getByRole("button", { name: /Yes, re-mint/i }));

    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
    const remintCall = authFetchMock.mock.calls.find(
      (c) => String(c[0]) === "https://api.test/api/organiser/weddings/wed_a/remint",
    );
    expect(JSON.parse(String((remintCall![1] as RequestInit).body)).codeStyle).toBe("secure");
  });
});
