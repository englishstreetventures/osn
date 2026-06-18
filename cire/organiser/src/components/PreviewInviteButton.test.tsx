// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * PreviewInviteButton owns the host-preview deep-link wiring: POST the
 * owner-gated /preview-code endpoint, then point a freshly-opened tab at the
 * guest invite with ?code=<publicId>. The tab is opened *synchronously* inside
 * the click handler — before any await — so mobile browsers keep the user
 * gesture and don't block the popup. The OSN auth + Effect runtime are stubbed;
 * this test asserts the wiring it introduces — the sync open, the happy path,
 * and each failure branch (which must never leave an orphaned blank tab).
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

type FakeWindow = ReturnType<typeof makeFakeWindow>;

/** A stand-in for the Window returned by window.open: a settable location + close(). */
function makeFakeWindow() {
  const win = {
    location: { href: "" },
    opener: {} as unknown,
    close: vi.fn(),
  };
  return win;
}

/** A typed window.open spy that returns `win` (or null when the popup is blocked). */
function makeOpenSpy(win: FakeWindow | null) {
  return vi.fn(
    (_url?: string | URL, _target?: string, _features?: string): FakeWindow | null => win,
  );
}

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

  it("opens the tab synchronously, before the auth fetch settles", async () => {
    // Resolve the fetch on a microtask so we can observe ordering: window.open
    // must already have fired by the time the click handler returns.
    let resolveFetch!: (res: Response) => void;
    authFetchMock.mockReturnValue(
      new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      }),
    );
    const win = makeFakeWindow();
    const openSpy = makeOpenSpy(win);
    vi.stubGlobal("open", openSpy);

    clickPreview();

    // Synchronous: the tab is open before the fetch promise has resolved.
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    // Opened blank (no destination yet) in a new tab. `_blank` is the target
    // (2nd) arg — never a misplaced "noopener". We must NOT pass "noopener" in
    // the features arg either: per spec that makes window.open return null and
    // we'd lose the handle. The opener reference is severed directly instead.
    const [openUrl, openTarget, openFeatures] = openSpy.mock.calls[0]!;
    expect(openUrl).toBe("");
    expect(openTarget).toBe("_blank");
    expect(String(openFeatures ?? "")).not.toContain("noopener");
    // Opener severed synchronously so the new tab can't reach back into the app.
    expect(win.opener).toBeNull();

    resolveFetch(
      new Response(JSON.stringify({ publicId: "HOST-ABCDEF0123456789ABCDEF01" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await waitFor(() => expect(win.location.href).toContain("?code=HOST-ABCDEF0123456789ABCDEF01"));
  });

  it("points the opened tab at the guest invite with ?code= on success", async () => {
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ publicId: "HOST-ABCDEF0123456789ABCDEF01" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const win = makeFakeWindow();
    const openSpy = makeOpenSpy(win);
    vi.stubGlobal("open", openSpy);

    clickPreview();

    // POSTs the wedding-scoped preview-code endpoint.
    await waitFor(() => expect(win.location.href).not.toBe(""));
    const [url, init] = authFetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/api/organiser/weddings/wed_bootstrap/preview-code");
    expect((init as RequestInit).method).toBe("POST");

    // Navigates the already-open tab to the guest site (no second window.open).
    expect(win.location.href).toContain("?code=HOST-ABCDEF0123456789ABCDEF01");
    // Severs the opener reference for the navigated tab.
    expect(win.opener).toBeNull();
    expect(win.close).not.toHaveBeenCalled();
  });

  it("falls back to same-tab navigation when the popup is blocked", async () => {
    authFetchMock.mockResolvedValue(
      new Response(JSON.stringify({ publicId: "HOST-ABCDEF0123456789ABCDEF01" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    // Popup blocked / unavailable -> window.open returns null.
    const openSpy = makeOpenSpy(null);
    vi.stubGlobal("open", openSpy);
    const assignSpy = vi.fn();
    vi.stubGlobal("location", { assign: assignSpy, href: "" });

    clickPreview();

    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(assignSpy.mock.calls[0]![0]).toContain("?code=HOST-ABCDEF0123456789ABCDEF01");
    // No crash, no error toast on the success path.
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("redirects to login on 401 and closes the blank tab (no orphan)", async () => {
    authFetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const win = makeFakeWindow();
    const openSpy = makeOpenSpy(win);
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("toasts an error on a non-ok response and closes the blank tab", async () => {
    authFetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const win = makeFakeWindow();
    const openSpy = makeOpenSpy(win);
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledTimes(1));
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.location.href).toBe("");
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("redirects to login when the session is expired (AuthExpiredError) and closes the tab", async () => {
    authFetchMock.mockRejectedValue(new Error("AuthExpiredError: token expired"));
    const win = makeFakeWindow();
    const openSpy = makeOpenSpy(win);
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(redirectSpy).toHaveBeenCalledTimes(1));
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  it("toasts an error on a generic network failure and closes the tab", async () => {
    authFetchMock.mockRejectedValue(new Error("network down"));
    const win = makeFakeWindow();
    const openSpy = makeOpenSpy(win);
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledTimes(1));
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(redirectSpy).not.toHaveBeenCalled();
  });

  it("does not crash on failure when the popup was blocked (null window)", async () => {
    authFetchMock.mockResolvedValue(new Response(null, { status: 500 }));
    const openSpy = makeOpenSpy(null);
    vi.stubGlobal("open", openSpy);

    clickPreview();

    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalledTimes(1));
    expect(redirectSpy).not.toHaveBeenCalled();
  });
});
