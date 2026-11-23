// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Both halves of the `/authorize` sign-in panel report success to the page.
 * Which half leads, from `initialMode`, is checked in
 * `tests/components/turnstile-wiring.test.tsx`; the switches between the halves
 * ("Create one", and Register's "Sign in instead") are checked by the
 * `musubi-passkey` flow's `/authorize` steps
 * (`tools/e2e/tests/flows/musubi-passkey.flow.ts`).
 *
 * The real ceremonies are stood in for: this is about what each half reports,
 * not what either does. The same three mocks as `turnstile-wiring.test.tsx`.
 */

vi.mock("@osn/auth-ui/SignIn", () => ({
  SignIn: (props: { onSuccess?: () => void }) => (
    <div data-testid="signin">
      <button type="button" onClick={() => props.onSuccess?.()}>
        complete sign-in
      </button>
    </div>
  ),
}));
vi.mock("@osn/auth-ui/Register", () => ({
  Register: (props: { onSuccess?: () => void }) => (
    <div data-testid="register">
      <button type="button" onClick={() => props.onSuccess?.()}>
        complete registration
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
