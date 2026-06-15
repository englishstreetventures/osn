// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * SignInPanel owns the only new logic in the organiser portal's login
 * surface: a signin/register mode toggle that lets an organiser without an
 * OSN account create one without leaving the page. The OSN ceremonies
 * themselves are exhaustively covered in @osn/ui (SignIn/Register tests),
 * so this test stubs those components and @osn/client and asserts only the
 * wiring it introduces — which view shows, and that the toggle/cancel
 * controls flip between them.
 */

vi.mock("@osn/client", () => ({
  createLoginClient: () => ({}),
  createRecoveryClient: () => ({}),
  createRegistrationClient: () => ({}),
}));

vi.mock("@osn/client/solid", () => ({
  // Pass children straight through; the real provider only supplies context
  // the stubbed SignIn/Register don't read.
  AuthProvider: (props: { children: unknown }) => props.children,
}));

vi.mock("@osn/ui/auth", () => ({
  SignIn: () => <div data-testid="signin-view">sign in</div>,
  Register: (props: { onCancel: () => void }) => (
    <div data-testid="register-view">
      <button onClick={() => props.onCancel()}>register-cancel</button>
    </div>
  ),
}));

vi.mock("solid-toast", () => ({
  Toaster: () => null,
  toast: { success: vi.fn(), error: vi.fn() },
}));

import SignInPanel from "./SignInPanel";

describe("SignInPanel", () => {
  afterEach(() => cleanup());

  it("shows the sign-in view by default, with a create-account toggle", () => {
    render(() => <SignInPanel />);
    expect(screen.getByTestId("signin-view")).toBeTruthy();
    expect(screen.queryByTestId("register-view")).toBeNull();
    expect(screen.getByRole("button", { name: /Create an account/i })).toBeTruthy();
  });

  it("switches to the register view when 'Create an account' is clicked", () => {
    render(() => <SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Create an account/i }));
    expect(screen.getByTestId("register-view")).toBeTruthy();
    expect(screen.queryByTestId("signin-view")).toBeNull();
  });

  it("returns to the sign-in view when Register cancels", () => {
    render(() => <SignInPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Create an account/i }));
    fireEvent.click(screen.getByRole("button", { name: /register-cancel/i }));
    expect(screen.getByTestId("signin-view")).toBeTruthy();
    expect(screen.queryByTestId("register-view")).toBeNull();
  });
});
