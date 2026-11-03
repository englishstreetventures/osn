// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cardClass } from "../src/card";
import SignInPanel, {
  SIGN_IN_PENDING_RESET_MS,
  type SignInAuth,
  signInCardClass,
} from "../src/sign-in-panel";

/**
 * The portals' sign-in is one hand-off through one door: a portal cannot run a
 * WebAuthn ceremony for `musubi.social`, so the button sends the host or the
 * vendor to cire/api's OIDC start leg and the issuer takes it from there. What
 * is pinned: the page does not leave on its own; it asks, behind the page,
 * whether this browser is signed in already; it carries the page a 401
 * bounced someone off as the return target, and only a same-origin path; a
 * failure coming back through `?auth_error` is shown once and wiped from the
 * address bar; and a press shows "Connecting to musubi…" without dimming,
 * ignores a second press, and never leaves the button dead.
 */

const API = "https://api.cire.test";

let marker: string | null = null;
const auth = {
  startSignIn: vi.fn<SignInAuth["startSignIn"]>(),
  resumeSession: vi.fn<SignInAuth["resumeSession"]>(() => Promise.resolve(false)),
  readAuthError: () => marker,
  clearAuthError: vi.fn<SignInAuth["clearAuthError"]>(),
} satisfies SignInAuth;

function at(search: string) {
  window.history.replaceState(null, "", `/login${search}`);
}

function renderPanel() {
  render(() => <SignInPanel apiBase={API} auth={auth} />);
  return screen.getByRole("button", { name: /musubi/i });
}

/** Where a press sends the browser back to, as a path with its query and hash. */
function returnedTo(): string {
  const [config, returnTo] = auth.startSignIn.mock.calls.at(-1)!;
  expect(config).toEqual({ apiBase: API });
  const url = new URL(returnTo);
  expect(url.origin).toBe(window.location.origin);
  return url.pathname + url.search + url.hash;
}

function resumedTo(): string {
  const [, options] = auth.resumeSession.mock.calls.at(-1)!;
  const url = new URL(options.home);
  expect(url.origin).toBe(window.location.origin);
  return url.pathname + url.search + url.hash;
}

/** A `pageshow`, as the browser fires one: happy-dom's carries no `persisted`. */
function pageshow(persisted: boolean) {
  const event = new Event("pageshow");
  Object.defineProperty(event, "persisted", { value: persisted });
  window.dispatchEvent(event);
}

beforeEach(() => {
  marker = null;
  at("");
  auth.startSignIn.mockClear();
  auth.resumeSession.mockClear();
  auth.clearAuthError.mockClear();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("SignInPanel", () => {
  it("waits for a choice rather than leaving on mount", () => {
    renderPanel();
    expect(auth.startSignIn).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(auth.clearAuthError).not.toHaveBeenCalled();
  });

  it("asks whether this browser is signed in already, aiming at the dashboard", () => {
    const button = renderPanel();
    expect(auth.resumeSession).toHaveBeenCalledTimes(1);
    expect(resumedTo()).toBe("/");
    // The button is usable while that question is still in flight.
    expect(button.textContent).toBe("Continue with musubi");
  });

  it("still checks for a session when arriving from a failed sign-in", () => {
    marker = "sign_in_failed";
    renderPanel();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(auth.resumeSession).toHaveBeenCalledTimes(1);
  });

  it("signs in, returning to the dashboard, with no prompt", () => {
    fireEvent.click(renderPanel());
    expect(auth.startSignIn).toHaveBeenCalledTimes(1);
    expect(returnedTo()).toBe("/");
    // A third argument would reopen the removed "create account" guess.
    expect(auth.startSignIn.mock.calls[0]).toHaveLength(2);
  });

  it("leaves account creation to the issuer instead of offering a second door", () => {
    renderPanel();
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /create account/i })).toBeNull();
    expect(screen.getByText(/create one on the next screen/i)).toBeTruthy();
  });

  it("explains a cancelled sign-in and strips the marker", () => {
    marker = "sign_in_declined";
    renderPanel();
    expect(screen.getByRole("alert").textContent).toMatch(/cancelled/i);
    expect(auth.clearAuthError).toHaveBeenCalledTimes(1);
    expect(auth.startSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ["sign_in_failed", /did not go through/i],
    ["sign_in_unavailable", /temporarily unavailable/i],
  ])("shows its own line for %s", (given, line) => {
    marker = given;
    renderPanel();
    expect(screen.getByRole("alert").textContent).toMatch(line);
  });

  it.each(["something_new", "toString", "__proto__"])(
    "falls back to the generic message for %s",
    (given) => {
      marker = given;
      renderPanel();
      expect(screen.getByRole("alert").textContent).toMatch(/did not go through/i);
    },
  );

  it("retries on demand after a failure", () => {
    marker = "sign_in_failed";
    fireEvent.click(renderPanel());
    expect(auth.startSignIn).toHaveBeenCalledTimes(1);
    expect(returnedTo()).toBe("/");
  });

  it("resumes on the page a 401 bounced someone off", () => {
    at(`?returnTo=${encodeURIComponent("/weddings/abc?tab=guests#row-4")}`);
    fireEvent.click(renderPanel());
    expect(resumedTo()).toBe("/weddings/abc?tab=guests#row-4");
    expect(returnedTo()).toBe("/weddings/abc?tab=guests#row-4");
  });

  it("drops a sign-in marker carried inside the page it resumes on", () => {
    at(`?returnTo=${encodeURIComponent("/?auth_error=sign_in_failed&tab=x#/w/1")}`);
    fireEvent.click(renderPanel());
    expect(resumedTo()).toBe("/?tab=x#/w/1");
    expect(returnedTo()).toBe("/?tab=x#/w/1");
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example",
    "/login",
    "/login/",
    "/login?returnTo=/x",
    "javascript:alert(1)",
    "evil",
  ])("refuses %s as a place to resume, and goes to the dashboard", (raw) => {
    at(`?returnTo=${encodeURIComponent(raw)}`);
    fireEvent.click(renderPanel());
    expect(resumedTo()).toBe("/");
    expect(returnedTo()).toBe("/");
  });

  it("says it is connecting after a press, at full strength, and ignores a second", () => {
    vi.useFakeTimers();
    const button = renderPanel();
    // Present and empty from the first paint, so its first words are spoken.
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(button);
    expect(button.textContent).toBe("Connecting to musubi…");
    expect(screen.getByRole("status").textContent).toBe("Connecting to musubi…");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(button);
    expect(auth.startSignIn).toHaveBeenCalledTimes(1);
    // The ignored press is answered: emptied, then refilled, so it is spoken.
    expect(screen.getByRole("status").textContent).toBe("");
    vi.advanceTimersByTime(100);
    expect(screen.getByRole("status").textContent).toBe("Still connecting to musubi…");
  });

  it("comes back usable when the page is restored from the back-forward cache", () => {
    const button = renderPanel();
    fireEvent.click(button);
    pageshow(false);
    expect(button.textContent).toBe("Connecting to musubi…");
    pageshow(true);
    expect(button.textContent).toBe("Continue with musubi");
    expect(screen.getByRole("status").textContent).toBe("");
    fireEvent.click(button);
    expect(auth.startSignIn).toHaveBeenCalledTimes(2);
  });

  it("comes back usable when the navigation never completes", () => {
    vi.useFakeTimers();
    const button = renderPanel();
    fireEvent.click(button);
    vi.advanceTimersByTime(SIGN_IN_PENDING_RESET_MS - 1);
    expect(button.textContent).toBe("Connecting to musubi…");
    vi.advanceTimersByTime(1);
    expect(button.textContent).toBe("Continue with musubi");
    fireEvent.click(button);
    expect(auth.startSignIn).toHaveBeenCalledTimes(2);
  });
});

describe("signInCardClass", () => {
  it("is the opaque card at the largest padding, with the lit top edge", () => {
    // The owner's choice (Stack 6, question 33, B).
    expect(signInCardClass).toBe(
      `${cardClass({ padding: "xl", fill: "opaque" })} base:shadow-(--inner-lip)`,
    );
  });
});
