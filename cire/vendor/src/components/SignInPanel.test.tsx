// @vitest-environment happy-dom
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

vi.mock("@osn/client", () => ({
  createLoginClient: () => ({}),
  createRecoveryClient: () => ({}),
  createRegistrationClient: () => ({}),
}));

vi.mock("@osn/client/solid", () => ({
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
  it("renders the sign-in form with a create-account switch", () => {
    render(() => <SignInPanel />);
    expect(screen.getByText(/create an account/i)).toBeInTheDocument();
  });
});
