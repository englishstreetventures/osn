// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The login surface is now one hand-off: the portal cannot run a WebAuthn
 * ceremony for `musubi.social`, so it sends the organiser to cire/api's OIDC
 * start leg. What is worth asserting here is the wiring — that the button
 * leaves for the API with the dashboard as the return target, and that a
 * failed attempt coming back through `?auth_error` is shown once and then
 * wiped from the address bar.
 */

const startSignIn = vi.fn();
const clearAuthError = vi.fn();
let authError: string | null = null;

vi.mock("@shared/rp-auth", () => ({
  startSignIn: (...args: unknown[]) => startSignIn(...args),
  clearAuthError: () => clearAuthError(),
  readAuthError: () => authError,
}));

import SignInPanel from "./SignInPanel";

describe("SignInPanel", () => {
  beforeEach(() => {
    authError = null;
    startSignIn.mockClear();
    clearAuthError.mockClear();
  });
  afterEach(() => cleanup());

  it("sends the organiser to the issuer, returning to the dashboard", () => {
    render(() => <SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Continue with musubi/i }));

    expect(startSignIn).toHaveBeenCalledTimes(1);
    const [, returnTo] = startSignIn.mock.calls[0]!;
    expect(new URL(returnTo as string).pathname).toBe("/");
  });

  it("shows nothing alarming when sign-in was never attempted", () => {
    render(() => <SignInPanel />);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(clearAuthError).not.toHaveBeenCalled();
  });

  it("explains a cancelled sign-in and strips the marker", () => {
    authError = "sign_in_declined";
    render(() => <SignInPanel />);

    expect(screen.getByRole("alert").textContent).toMatch(/cancelled/i);
    expect(clearAuthError).toHaveBeenCalledTimes(1);
  });

  it("falls back to the generic message for an unknown marker", () => {
    authError = "something_new";
    render(() => <SignInPanel />);
    expect(screen.getByRole("alert").textContent).toMatch(/did not go through/i);
  });
});
