// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { createSignal, type Accessor } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

// Stand-ins for the real ceremonies (same approach as turnstile-wiring.test.tsx):
// this file tests the wrapper's open/close logic, not the forms themselves.
// The Register stand-in exposes a button that fires `onSuccess`, which is how
// the real component signals "account created and passkey enrolled".
vi.mock("@osn/ui/auth/SignIn", () => ({
  SignIn: (props: { onSuccess?: () => void }) => (
    <div data-testid="signin">
      <button type="button" data-testid="signin-finished" onClick={() => props.onSuccess?.()}>
        finish
      </button>
    </div>
  ),
}));
vi.mock("@osn/ui/auth/Register", () => ({
  Register: (props: { onSuccess?: () => void }) => (
    <div data-testid="register">
      <button type="button" data-testid="register-finished" onClick={() => props.onSuccess?.()}>
        finish
      </button>
    </div>
  ),
}));
vi.mock("../../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
}));

import { AuthDialogs } from "../../src/components/AuthDialogs";

function resource<T>(read: Accessor<T>) {
  return Object.assign(read, {
    state: "ready",
    loading: false,
    error: undefined,
    latest: null,
    refetch: () => {},
    mutate: () => {},
  });
}

function makeAuth(session: Accessor<unknown>) {
  const authValue = {
    session: resource(session),
    profiles: resource(() => null),
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

const SAMPLE_SESSION = { accessToken: "tkn", idToken: null, expiresAt: 0, scopes: [] };

function renderDialogs(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext value
  auth: any,
  open: { signIn?: boolean; register?: boolean },
  handlers: {
    onShowRegisterChange?: (open: boolean) => void;
    onShowSignInChange?: (open: boolean) => void;
  } = {},
) {
  return render(() => (
    <AuthContext.Provider value={auth}>
      <AuthDialogs
        showRegister={open.register ?? false}
        onShowRegisterChange={handlers.onShowRegisterChange ?? (() => {})}
        showSignIn={open.signIn ?? false}
        onShowSignInChange={handlers.onShowSignInChange ?? (() => {})}
      />
    </AuthContext.Provider>
  ));
}

afterEach(() => {
  cleanup();
});

describe("<AuthDialogs /> — close-on-session invariant", () => {
  it("renders the requested dialog while signed out", () => {
    renderDialogs(
      makeAuth(() => null),
      { signIn: true },
    );
    expect(screen.getByTestId("signin")).toBeDefined();
  });

  it("never renders an auth dialog once a session exists", () => {
    renderDialogs(
      makeAuth(() => SAMPLE_SESSION),
      { signIn: true, register: true },
    );
    // Both open flags are true, but the `!session()` guard wins — a signed-in
    // user must never see a stale auth sheet over the app.
    expect(screen.queryByTestId("signin")).toBeNull();
    expect(screen.queryByTestId("register")).toBeNull();
  });

  // The bug: `showRegister` was never reset. Registration finished, the
  // session guard hid the dialog, and the flag stayed `true` — so the next
  // time the session went away (logout, expiry) the create-account modal
  // reappeared on its own.
  it("closes the register dialog when registration reports success", () => {
    const onShowRegisterChange = vi.fn();
    renderDialogs(
      makeAuth(() => null),
      { register: true },
      { onShowRegisterChange },
    );
    fireEvent.click(screen.getByTestId("register-finished"));
    expect(onShowRegisterChange).toHaveBeenCalledWith(false);
  });

  it("closes the sign-in dialog when sign-in reports success", () => {
    const onShowSignInChange = vi.fn();
    renderDialogs(
      makeAuth(() => null),
      { signIn: true },
      { onShowSignInChange },
    );
    fireEvent.click(screen.getByTestId("signin-finished"));
    expect(onShowSignInChange).toHaveBeenCalledWith(false);
  });

  it("clears both open flags the moment a session appears", async () => {
    const [session, setSession] = createSignal<unknown>(null);
    const onShowRegisterChange = vi.fn();
    const onShowSignInChange = vi.fn();
    renderDialogs(
      makeAuth(session),
      { register: true, signIn: true },
      { onShowRegisterChange, onShowSignInChange },
    );
    expect(onShowRegisterChange).not.toHaveBeenCalled();
    expect(onShowSignInChange).not.toHaveBeenCalled();

    // A session can arrive from anywhere — another tab, a cookie bootstrap,
    // a sign-in that skips `onSuccess`. Whatever the source, the flags reset
    // so a later logout leaves the shell alone.
    setSession(SAMPLE_SESSION);
    await Promise.resolve();

    expect(onShowRegisterChange).toHaveBeenCalledWith(false);
    expect(onShowSignInChange).toHaveBeenCalledWith(false);
  });

  // Only the flag that was actually set gets cleared. Without the per-flag
  // guards the effect would fire both setters on every session, in every shell
  // — including the two that mount signed-in and never opened a dialog.
  it("clears only the flag that was set, and none when both are shut", async () => {
    const [session, setSession] = createSignal<unknown>(null);
    const onShowRegisterChange = vi.fn();
    const onShowSignInChange = vi.fn();
    renderDialogs(
      makeAuth(session),
      { register: true },
      { onShowRegisterChange, onShowSignInChange },
    );

    setSession(SAMPLE_SESSION);
    await Promise.resolve();

    expect(onShowRegisterChange).toHaveBeenCalledWith(false);
    expect(onShowSignInChange).not.toHaveBeenCalled();
  });

  it("touches neither flag when a session arrives with both dialogs shut", async () => {
    const [session, setSession] = createSignal<unknown>(null);
    const onShowRegisterChange = vi.fn();
    const onShowSignInChange = vi.fn();
    renderDialogs(makeAuth(session), {}, { onShowRegisterChange, onShowSignInChange });

    setSession(SAMPLE_SESSION);
    await Promise.resolve();

    expect(onShowRegisterChange).not.toHaveBeenCalled();
    expect(onShowSignInChange).not.toHaveBeenCalled();
  });
});
