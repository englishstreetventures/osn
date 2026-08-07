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

const toastErrorSpy = vi.fn();

vi.mock("@shared/rp-auth/solid", async () => {
  const { rpAuthSolidMock } = await import("../test-support/mocks");
  return rpAuthSolidMock();
});

vi.mock("solid-toast", () => ({
  toast: { success: vi.fn(), error: (...args: unknown[]) => toastErrorSpy(...args) },
}));

// Mock the api helpers so we can spy on the redirect without a real navigation,
// and keep apiUrl deterministic. isAuthExpired mirrors the real string check.
vi.mock("../lib/api", async () => {
  const { organiserApiMock } = await import("../test-support/mocks");
  return organiserApiMock();
});

import { authFetchMock, redirectSpy, resetOrganiserMocks } from "../test-support/mocks";
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
    resetOrganiserMocks();
    toastErrorSpy.mockReset();
    vi.unstubAllGlobals();
  });

  it("collapses to its glyph on a narrow bar without dropping its accessible name", () => {
    // The regression: the top bar used to wrap this button in
    // `hidden @2xl/frame:inline`, which left a phone with NO route to the guest
    // preview at all — the command palette carries modules, weddings and
    // account, but no preview command. The button is mounted at every width
    // now, so what has to hold here is that shrinking it never costs it its
    // name. Container queries do not resolve under happy-dom, so this pins the
    // class contract; the painted widths belong to the browser tier.
    render(() => <PreviewInviteButton weddingId="wed_bootstrap" />);
    // The STRING form, not a regex: testing-library matches a string exactly
    // (after normalisation) and a regex as a substring, so `/Preview invite/i`
    // would be satisfied by "◎ Preview invite" — precisely the name you get if
    // `aria-hidden` came off the glyph, which is the failure this asserts against.
    const button = screen.getByRole("button", { name: "Preview invite" });

    // The label collapses with `sr-only`, never `hidden`: on the narrow width
    // it is the only thing naming the control, so it must stay in the tree.
    const label = button.querySelector("span:not([aria-hidden])") as HTMLElement;
    expect(label.className).toContain("sr-only");
    expect(label.className).toContain("@2xl/frame:not-sr-only");
    expect(label.className).not.toContain("hidden");

    // The glyph is decoration standing in for the label, so it must never
    // reach the accessible name — which the exact-string `getByRole` above
    // proves, since an unhidden glyph would prepend to that name.
    const glyph = button.querySelector("span[aria-hidden='true']") as HTMLElement;
    expect(glyph.textContent?.trim()).toBe("◎");
    expect(glyph.className).toContain("@2xl/frame:hidden");
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
      new Response(
        JSON.stringify({
          publicId: "HOST-ABCDEF0123456789ABCDEF01",
          slug: "alexander-samantha-a1b2c3",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );

    await waitFor(() => expect(win.location.href).toContain("?code=HOST-ABCDEF0123456789ABCDEF01"));
  });

  it("points the opened tab at the guest invite with ?code= on success", async () => {
    authFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          publicId: "HOST-ABCDEF0123456789ABCDEF01",
          slug: "alexander-samantha-a1b2c3",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
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
    // Path-routed: the wedding slug rides in the PATH, the host code in ?code=.
    expect(win.location.href).toBe(
      "http://localhost:4321/alexander-samantha-a1b2c3?code=HOST-ABCDEF0123456789ABCDEF01",
    );
    // Severs the opener reference for the navigated tab.
    expect(win.opener).toBeNull();
    expect(win.close).not.toHaveBeenCalled();
  });

  it("falls back to same-tab navigation when the popup is blocked", async () => {
    authFetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          publicId: "HOST-ABCDEF0123456789ABCDEF01",
          slug: "alexander-samantha-a1b2c3",
        }),
        {
          status: 200,
          headers: { "Content-Type": "application/json" },
        },
      ),
    );
    // Popup blocked / unavailable -> window.open returns null.
    const openSpy = makeOpenSpy(null);
    vi.stubGlobal("open", openSpy);
    const assignSpy = vi.fn();
    vi.stubGlobal("location", { assign: assignSpy, href: "" });

    clickPreview();

    await waitFor(() => expect(assignSpy).toHaveBeenCalledTimes(1));
    expect(assignSpy.mock.calls[0]![0]).toBe(
      "http://localhost:4321/alexander-samantha-a1b2c3?code=HOST-ABCDEF0123456789ABCDEF01",
    );
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
