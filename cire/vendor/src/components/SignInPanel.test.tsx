// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The login surface is one hand-off through one door: the portal cannot run a
 * WebAuthn ceremony for `musubi.social`, so the button sends the vendor to
 * cire/api's OIDC start leg and the issuer takes it from there. There is no
 * second "create account" door, and that absence is asserted rather than
 * assumed — the issuer's own sign-in screen offers sign-up, and only the issuer
 * knows whether this person already has an account. What else is worth pinning
 * down: the page does not leave on its own, it carries the dashboard as the
 * return target, and a failure coming back through `?auth_error` is shown once
 * and then wiped from the address bar.
 *
 * The one thing that does happen unbidden is the session check: a vendor who
 * still holds a cire session is carried through to the dashboard rather than
 * asked for a second one. It runs behind the rendered page, so the button is
 * there either way.
 */

const startSignIn = vi.fn();
const clearAuthError = vi.fn();
const resumeSession = vi.fn((..._args: unknown[]) => Promise.resolve(false));
let authError: string | null = null;

vi.mock("@shared/rp-auth", () => ({
  startSignIn: (...args: unknown[]) => startSignIn(...args),
  clearAuthError: () => clearAuthError(),
  readAuthError: () => authError,
  resumeSession: (...args: unknown[]) => resumeSession(...args),
}));

import SignInPanel from "./SignInPanel";

describe("SignInPanel", () => {
  beforeEach(() => {
    authError = null;
    startSignIn.mockClear();
    clearAuthError.mockClear();
    resumeSession.mockClear();
  });
  afterEach(() => cleanup());

  it("waits for a choice rather than leaving on mount", () => {
    render(() => <SignInPanel />);

    expect(startSignIn).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(clearAuthError).not.toHaveBeenCalled();
  });

  it("asks whether this browser is signed in already, aiming at the dashboard", () => {
    render(() => <SignInPanel />);

    expect(resumeSession).toHaveBeenCalledTimes(1);
    const [, options] = resumeSession.mock.calls[0]! as [unknown, { home: string }];
    expect(new URL(options.home).pathname).toBe("/");
    // The button is usable while that question is still in flight.
    expect(screen.getByRole("button", { name: /Continue with musubi/i })).toBeTruthy();
  });

  it("still checks for a session when arriving from a failed sign-in", () => {
    authError = "sign_in_failed";
    render(() => <SignInPanel />);

    expect(screen.getByRole("alert")).toBeTruthy();
    expect(resumeSession).toHaveBeenCalledTimes(1);
  });

  it("signs in, returning to the dashboard", () => {
    render(() => <SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Continue with musubi/i }));

    expect(startSignIn).toHaveBeenCalledTimes(1);
    const [, returnTo, options] = startSignIn.mock.calls[0]!;
    expect(new URL(returnTo as string).pathname).toBe("/");
    // T-S2: and no `prompt`. Removing the second button is only half the
    // change — passing `{ prompt: "create" }` through the one that remains
    // would reinstate the removed guess, and every other assertion here
    // (the button count, the absent "Create account" label) would stay green.
    expect(options).toBeUndefined();
  });

  it("leaves account creation to the issuer instead of offering a second door", () => {
    render(() => <SignInPanel />);

    // One way out of this page. Someone with no musubi account takes the same
    // one and creates the account on the issuer's screen, which is the only
    // side that knows whether they already have one.
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: /Create account/i })).toBeNull();
    expect(screen.getByText(/create one on the next screen/i)).toBeTruthy();
  });

  it("explains a cancelled sign-in and strips the marker", () => {
    authError = "sign_in_declined";
    render(() => <SignInPanel />);

    expect(screen.getByRole("alert").textContent).toMatch(/cancelled/i);
    expect(clearAuthError).toHaveBeenCalledTimes(1);
    expect(startSignIn).not.toHaveBeenCalled();
  });

  it("falls back to the generic message for an unknown marker", () => {
    authError = "something_new";
    render(() => <SignInPanel />);

    expect(screen.getByRole("alert").textContent).toMatch(/did not go through/i);
  });

  it("retries on demand after a failure", () => {
    authError = "sign_in_failed";
    render(() => <SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Continue with musubi/i }));

    expect(startSignIn).toHaveBeenCalledTimes(1);
    const [, returnTo] = startSignIn.mock.calls[0]!;
    expect(new URL(returnTo as string).pathname).toBe("/");
  });
});
