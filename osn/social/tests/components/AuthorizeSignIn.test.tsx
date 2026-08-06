// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * T-M1. `AuthorizePage` decides which half of this panel leads and hands the
 * answer over as `initialMode`; its own tests mock this island and assert the
 * prop. That left one hop untested — the one where the decision becomes a
 * rendered form. `props.initialMode ?? "signIn"` could be dropped or inverted
 * and every test in `osn/social` would still pass, while a relying party's
 * `prompt=create` visitor landed on a screen demanding a passkey they have not
 * got. This file covers that hop, and the two ways a user moves between the
 * halves once they are on it.
 *
 * The real ceremonies are stood in for: this is about which one mounts, not
 * what either does. The same three mocks as `turnstile-wiring.test.tsx`.
 */

vi.mock("@osn/ui/auth/SignIn", () => ({
  SignIn: (props: { onSuccess?: () => void }) => (
    <div data-testid="signin">
      <button type="button" onClick={() => props.onSuccess?.()}>
        complete sign-in
      </button>
    </div>
  ),
}));
vi.mock("@osn/ui/auth/Register", () => ({
  Register: (props: { onSuccess?: () => void; onCancel?: () => void }) => (
    <div data-testid="register">
      <button type="button" onClick={() => props.onSuccess?.()}>
        complete registration
      </button>
      <button type="button" onClick={() => props.onCancel?.()}>
        cancel registration
      </button>
    </div>
  ),
}));
// `AuthorizeSignIn` wraps both in a provider that bootstraps a session
// (POST /token) on mount — irrelevant here, and it would hit the network.
vi.mock("@osn/client/solid", async () => {
  const actual = await vi.importActual<typeof import("@osn/client/solid")>("@osn/client/solid");
  return {
    ...actual,
    AuthProvider: (props: { children?: unknown }) => props.children,
  };
});
vi.mock("../../src/lib/authClients", () => ({
  loginClient: {},
  recoveryClient: {},
  registrationClient: {},
  passkeysClient: {},
  stepUpClient: {},
}));

import { AuthorizeSignIn } from "../../src/components/AuthorizeSignIn";

afterEach(() => cleanup());

describe("<AuthorizeSignIn />", () => {
  it("mounts the registration half when the page asks for it", () => {
    render(() => <AuthorizeSignIn initialMode="register" onSuccess={() => {}} />);

    expect(screen.getByTestId("register")).toBeTruthy();
    expect(screen.queryByTestId("signin")).toBeNull();
  });

  it("leads with sign-in by default", () => {
    render(() => <AuthorizeSignIn onSuccess={() => {}} />);

    expect(screen.getByTestId("signin")).toBeTruthy();
    expect(screen.queryByTestId("register")).toBeNull();
  });

  /**
   * The half that makes the cire portals' single sign-in button work: a visitor
   * sent here with no account gets `reason=login`, not `create`, and this link
   * is the whole of their route to an account.
   */
  it("offers a way to register from the sign-in half", () => {
    render(() => <AuthorizeSignIn initialMode="signIn" onSuccess={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /create one/i }));

    expect(screen.getByTestId("register")).toBeTruthy();
    expect(screen.queryByTestId("signin")).toBeNull();
  });

  it("returns to sign-in when registration is cancelled", () => {
    render(() => <AuthorizeSignIn initialMode="register" onSuccess={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /cancel registration/i }));

    expect(screen.getByTestId("signin")).toBeTruthy();
    expect(screen.queryByTestId("register")).toBeNull();
  });

  /**
   * Both halves end the same way. Registration finishes with an enrolled
   * passkey and an adopted session — exactly what the parked request is waiting
   * for — so it reports success rather than handing the user back for a second
   * ceremony.
   */
  it("reports success from whichever half ran", () => {
    const onSuccess = vi.fn();
    const { unmount } = render(() => (
      <AuthorizeSignIn initialMode="register" onSuccess={onSuccess} />
    ));
    fireEvent.click(screen.getByRole("button", { name: /complete registration/i }));
    expect(onSuccess).toHaveBeenCalledTimes(1);
    unmount();

    render(() => <AuthorizeSignIn initialMode="signIn" onSuccess={onSuccess} />);
    fireEvent.click(screen.getByRole("button", { name: /complete sign-in/i }));
    expect(onSuccess).toHaveBeenCalledTimes(2);
  });
});
