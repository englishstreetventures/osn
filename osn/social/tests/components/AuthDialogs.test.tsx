// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stand-ins for the real ceremonies (same approach as turnstile-wiring.test.tsx):
// this file tests the wrapper's open/close logic, not the forms themselves.
vi.mock("@osn/ui/auth/SignIn", () => ({
  SignIn: () => <div data-testid="signin" />,
}));
vi.mock("@osn/ui/auth/Register", () => ({
  Register: () => <div data-testid="register" />,
}));
vi.mock("../../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
}));

import { AuthDialogs } from "../../src/components/AuthDialogs";

function resource<T>(value: T) {
  return Object.assign(() => value, {
    state: "ready",
    loading: false,
    error: undefined,
    latest: null,
    refetch: () => {},
    mutate: () => {},
  });
}

function makeAuth(session: unknown) {
  const authValue = {
    session: resource(session),
    profiles: resource(null),
    activeProfileId: () => null,
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => Promise.reject(new Error("unused")),
    createProfile: () => Promise.reject(new Error("unused")),
    deleteProfile: () => Promise.resolve(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required
  return authValue as any;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext value
function renderDialogs(auth: any, open: { signIn?: boolean; register?: boolean }) {
  return render(() => (
    <AuthContext.Provider value={auth}>
      <AuthDialogs
        showRegister={open.register ?? false}
        onShowRegisterChange={() => {}}
        showSignIn={open.signIn ?? false}
        onShowSignInChange={() => {}}
      />
    </AuthContext.Provider>
  ));
}

afterEach(() => {
  cleanup();
});

describe("<AuthDialogs /> — close-on-session invariant", () => {
  it("renders the requested dialog while signed out", () => {
    renderDialogs(makeAuth(null), { signIn: true });
    expect(screen.getByTestId("signin")).toBeDefined();
  });

  it("never renders an auth dialog once a session exists", () => {
    const session = { accessToken: "tkn", idToken: null, expiresAt: 0, scopes: [] };
    renderDialogs(makeAuth(session), { signIn: true, register: true });
    // Both open flags are true, but the `!session()` guard wins — a signed-in
    // user must never see a stale auth sheet over the app.
    expect(screen.queryByTestId("signin")).toBeNull();
    expect(screen.queryByTestId("register")).toBeNull();
  });
});
