// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PreviewInviteButton owns the host-preview deep-link wiring: POST the
 * owner-gated /preview-code endpoint, then open the guest invite in a new tab
 * with ?code=<publicId>. The OSN auth + Effect runtime are stubbed; this test
 * asserts the wiring it introduces — the happy path plus each failure branch.
 */

const authFetchMock = vi.fn();
const redirectSpy = vi.fn();
const toastErrorSpy = vi.fn();

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({ authFetch: authFetchMock }),
}));

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => toastErrorSpy(...args) },
}));

// Mock the api helpers so we can spy on the redirect without a real navigation,
// and keep apiUrl deterministic. isAuthExpired mirrors the real string check.
vi.mock("../lib/api", () => ({
  apiUrl: (path: string) => `https://api.test${path}`,
  isAuthExpired: (err: unknown) => String(err).includes("AuthExpiredError"),
  redirectToLogin: () => redirectSpy(),
}));

import PreviewInviteButton from "./PreviewInviteButton";

function clickPreview() {
  render(() => <PreviewInviteButton weddingId="wed_bootstrap" />);
  fireEvent.click(screen.getByRole("button", { name: /Preview invite/i }));
}

describe("PreviewInviteButton", () => {
  afterEach(() => {
    cleanup();
    authFetchMock.mockReset();
    redirectSpy.mockReset();
    toastErrorSpy.mockReset();
    vi.unstubAllGlobals();
  });

  it("provisions the host code and opens the guest invite with ?code=", async () => {
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ publicId: "HOST-ABCDEF0123456789ABCDEF01" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));

    // POSTs the wedding-scoped preview-code endpoint.
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/organiser/weddings/wed_bootstrap/preview-code");
    expect((init as RequestInit).method).toBe("POST");

    // Opens the guest site with the returned host code pre-filled.
    const opened = openSpy.mock.calls[0]![0] as string;
    expect(opened).toContain("?code=HOST-ABCDEF0123456789ABCDEF01");
  });

  it("redirects to login on 401 and does not open a tab", async () => {
    authFetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).not.toHaveBeenCalled();
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("toasts an error on a non-ok response and does not open a tab", async () => {
    authFetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("redirects to login when the session is expired (AuthExpiredError)", async () => {
    authFetchMock.mockRejectedValue(new Error("AuthExpiredError: token expired"));
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).not.toHaveBeenCalled();
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("toasts an error on a generic network failure", async () => {
    authFetchMock.mockRejectedValue(new Error("network down"));
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledTimes(1));
    expect(openSpy).not.toHaveBeenCalled();
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});
