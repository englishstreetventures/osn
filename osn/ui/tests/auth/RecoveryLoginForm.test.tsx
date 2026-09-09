// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Every way back into an account that is not a passkey.
 *
 * Three factors, and the split that matters is between the recovery code —
 * which mints an ordinary session — and the two that mint a *restricted*
 * recovery session whose only permitted action is enrolling a passkey.
 *
 * `browserSupportsWebAuthn` is mocked rather than left to the environment.
 * happy-dom has no `PublicKeyCredential`, so the real function returns false
 * and the "hides the restricted factors" assertion would pass whether or not
 * the guard existed — a test that cannot go red. Both branches are driven.
 */

const hoisted = vi.hoisted(() => ({
  adoptSession: vi.fn(),
  webauthnSupported: true,
}));

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    adoptSession: hoisted.adoptSession,
  }),
}));

vi.mock("@simplewebauthn/browser", () => ({
  browserSupportsWebAuthn: () => hoisted.webauthnSupported,
}));

import type { RecoveryClient, RegistrationClient } from "@osn/client";

import { RecoveryLoginForm } from "../../src/auth/RecoveryLoginForm";

interface ClientStub {
  generateRecoveryCodes: ReturnType<typeof vi.fn>;
  loginWithRecoveryCode: ReturnType<typeof vi.fn>;
  emailRecoveryBegin: ReturnType<typeof vi.fn>;
  emailRecoveryComplete: ReturnType<typeof vi.fn>;
  totpRecoveryComplete: ReturnType<typeof vi.fn>;
}

interface RegistrationStub {
  passkeyRegisterBegin: ReturnType<typeof vi.fn>;
  passkeyRegisterComplete: ReturnType<typeof vi.fn>;
}

function makeClientStub(): ClientStub {
  return {
    generateRecoveryCodes: vi.fn(),
    loginWithRecoveryCode: vi.fn(),
    emailRecoveryBegin: vi.fn(),
    emailRecoveryComplete: vi.fn(),
    totpRecoveryComplete: vi.fn(),
  };
}

function makeRegistrationStub(): RegistrationStub {
  return {
    passkeyRegisterBegin: vi.fn().mockResolvedValue({ challenge: "abc" }),
    passkeyRegisterComplete: vi.fn().mockResolvedValue({ passkeyId: "pk_new" }),
  };
}

const asClient = (s: ClientStub): RecoveryClient => s as unknown as RecoveryClient;
const asRegistration = (s: RegistrationStub): RegistrationClient =>
  s as unknown as RegistrationClient;

const ACCESS_TOKEN = "acc_recovery";

/** A restricted recovery session, five minutes out. */
const restrictedSession = {
  accessToken: ACCESS_TOKEN,
  idToken: null,
  expiresAt: Date.now() + 300_000,
  scopes: [],
};

const sampleSession = {
  accessToken: "acc_x",
  idToken: null,
  expiresAt: Date.now() + 60_000,
  scopes: [],
};

const sampleProfile = {
  id: "usr_1",
  handle: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  avatarUrl: null,
};

const attestation = { id: "cred", rawId: "cred", type: "public-key" };

let stub: ClientStub;
let registration: RegistrationStub;

function fill(label: RegExp, value: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  return input;
}

function typeCode(value: string) {
  const boxes = screen.getAllByLabelText(/^Digit \d$/);
  for (const [i, ch] of [...value].entries()) {
    fireEvent.input(boxes[i]!, { target: { value: ch } });
  }
}

/** Mounts with everything the restricted paths need. */
function mountFull(overrides: { onSuccess?: () => void; onCancel?: () => void } = {}) {
  render(() => (
    <RecoveryLoginForm
      client={asClient(stub)}
      registrationClient={asRegistration(registration)}
      runPasskeyRegistration={async () => attestation as never}
      onSuccess={overrides.onSuccess}
      onCancel={overrides.onCancel}
    />
  ));
}

/** Opens the recovery-code form from the chooser. */
function openRecoveryCode() {
  fireEvent.click(screen.getByRole("button", { name: /Use a recovery code/i }));
}

beforeEach(() => {
  stub = makeClientStub();
  registration = makeRegistrationStub();
  hoisted.adoptSession.mockReset();
  hoisted.webauthnSupported = true;
});

afterEach(() => cleanup());

describe("RecoveryLoginForm — recovery code", () => {
  it("submit button is disabled until both fields are populated", () => {
    mountFull();
    openRecoveryCode();
    const submit = screen.getByRole("button", {
      name: /Sign in with recovery code/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fill(/Handle or email/i, "alice@example.com");
    expect(submit.disabled).toBe(true); // still missing code

    fill(/Recovery code/i, "abcd-1234-5678-ef00");
    expect(submit.disabled).toBe(false);
  });

  it("calls loginWithRecoveryCode + adoptSession + onSuccess on submit", async () => {
    stub.loginWithRecoveryCode.mockResolvedValue({
      session: sampleSession,
      profile: sampleProfile,
    });
    hoisted.adoptSession.mockResolvedValue(undefined);
    const onSuccess = vi.fn();
    mountFull({ onSuccess });
    openRecoveryCode();

    fill(/Handle or email/i, "alice@example.com");
    fill(/Recovery code/i, "abcd-1234-5678-ef00");
    fireEvent.click(screen.getByRole("button", { name: /Sign in with recovery code/i }));

    await waitFor(() => {
      expect(stub.loginWithRecoveryCode).toHaveBeenCalledWith({
        identifier: "alice@example.com",
        code: "abcd-1234-5678-ef00",
      });
      // This factor alone mints an ordinary session, so this factor alone
      // adopts one.
      expect(hoisted.adoptSession).toHaveBeenCalledWith(sampleSession);
      expect(onSuccess).toHaveBeenCalledTimes(1);
    });
  });

  it("trims whitespace around identifier and code before submitting", async () => {
    stub.loginWithRecoveryCode.mockResolvedValue({
      session: sampleSession,
      profile: sampleProfile,
    });
    hoisted.adoptSession.mockResolvedValue(undefined);
    mountFull();
    openRecoveryCode();

    fill(/Handle or email/i, "  alice  ");
    fill(/Recovery code/i, "  abcd-1234-5678-ef00  ");
    fireEvent.click(screen.getByRole("button", { name: /Sign in with recovery code/i }));

    await waitFor(() => {
      expect(stub.loginWithRecoveryCode).toHaveBeenCalledWith({
        identifier: "alice",
        code: "abcd-1234-5678-ef00",
      });
    });
  });

  it("surfaces a generic error on failure and leaves the form usable", async () => {
    // Deliberately pass a verbose server message — the UI must NOT render it
    // verbatim, to preserve the no-enumeration posture of the server response.
    stub.loginWithRecoveryCode.mockRejectedValue(
      new Error("User does not exist: nobody@example.com"),
    );
    mountFull();
    openRecoveryCode();

    fill(/Handle or email/i, "nobody@example.com");
    fill(/Recovery code/i, "wrng-wrng-wrng-wrng");
    fireEvent.click(screen.getByRole("button", { name: /Sign in with recovery code/i }));

    await waitFor(() => {
      expect(screen.getByText(/That recovery code didn't work/i)).toBeTruthy();
    });
    expect(screen.queryByText(/User does not exist/)).toBeNull();
    expect(hoisted.adoptSession).not.toHaveBeenCalled();

    const submit = screen.getByRole("button", {
      name: /Sign in with recovery code/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("invokes onCancel from the chooser", () => {
    const onCancel = vi.fn();
    mountFull({ onCancel });
    fireEvent.click(screen.getByRole("button", { name: /Back to sign in/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});

describe("RecoveryLoginForm — which factors are offered", () => {
  it("offers all three when a WebAuthn ceremony can run", () => {
    mountFull();
    expect(screen.getByRole("button", { name: /Use a recovery code/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Email me a code/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Use my authenticator app/i })).toBeTruthy();
  });

  it("hides both restricted factors when the browser has no WebAuthn", () => {
    // A restricted recovery session's ONE permitted action is a WebAuthn
    // ceremony. Where that cannot run, the session can do nothing at all, so
    // offering either path mints a useless credential and strands the user
    // when it expires.
    hoisted.webauthnSupported = false;
    mountFull();

    expect(screen.getByRole("button", { name: /Use a recovery code/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Email me a code/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Use my authenticator app/i })).toBeNull();
    // And says what does work instead, rather than showing a shorter menu
    // with no explanation.
    expect(screen.getByText(/cross-device/i)).toBeTruthy();
    expect(screen.getByText(/security key/i)).toBeTruthy();
  });

  it("hides both restricted factors when the host wired no enrolment path", () => {
    // Same rule, other half: a factor is offered only when everything needed
    // to finish it is present.
    render(() => <RecoveryLoginForm client={asClient(stub)} />);
    expect(screen.getByRole("button", { name: /Use a recovery code/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Email me a code/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Use my authenticator app/i })).toBeNull();
  });
});

describe("RecoveryLoginForm — email recovery", () => {
  it("asks for an email address, not a handle", () => {
    // `/login/recovery/email/begin` refuses a handle — it puts mail in
    // somebody's inbox and a handle is public — and the refusal is flattened
    // on the wire, so a shared "handle or email" field would produce an error
    // with nothing in it.
    mountFull();
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));
    expect(screen.getByLabelText(/Email address on the account/i)).toBeTruthy();
    expect(screen.queryByLabelText(/Handle or email/i)).toBeNull();
  });

  it("sends a code, then exchanges it for a restricted session", async () => {
    stub.emailRecoveryBegin.mockResolvedValue(undefined);
    stub.emailRecoveryComplete.mockResolvedValue({
      session: restrictedSession,
      profile: sampleProfile,
    });
    mountFull();

    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));
    fill(/Email address on the account/i, "alice@example.com");
    fireEvent.click(screen.getByRole("button", { name: /Send the code/i }));

    await waitFor(() =>
      expect(stub.emailRecoveryBegin).toHaveBeenCalledWith({
        identifier: "alice@example.com",
        turnstileToken: undefined,
      }),
    );

    typeCode("123456");
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));

    await waitFor(() =>
      expect(stub.emailRecoveryComplete).toHaveBeenCalledWith({
        identifier: "alice@example.com",
        code: "123456",
      }),
    );
  });

  it("says nothing about whether the address matched an account", async () => {
    stub.emailRecoveryBegin.mockResolvedValue(undefined);
    mountFull();
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));
    fill(/Email address on the account/i, "nobody@example.com");
    fireEvent.click(screen.getByRole("button", { name: /Send the code/i }));

    // The server answers the same either way; the copy has to match, or the
    // screen becomes the oracle the endpoint refuses to be.
    await waitFor(() => expect(screen.getByText(/If that address has an account/i)).toBeTruthy());
  });
});

describe("RecoveryLoginForm — authenticator recovery", () => {
  it("exchanges an identifier and code for a restricted session", async () => {
    stub.totpRecoveryComplete.mockResolvedValue({
      session: restrictedSession,
      profile: sampleProfile,
    });
    mountFull();

    fireEvent.click(screen.getByRole("button", { name: /Use my authenticator app/i }));
    fill(/Handle or email/i, "  alice  ");
    typeCode("654321");
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));

    await waitFor(() =>
      expect(stub.totpRecoveryComplete).toHaveBeenCalledWith({
        identifier: "alice",
        code: "654321",
      }),
    );
  });
});

describe("RecoveryLoginForm — the restricted session", () => {
  async function reachEnrolment() {
    stub.totpRecoveryComplete.mockResolvedValue({
      session: restrictedSession,
      profile: sampleProfile,
    });
    fireEvent.click(screen.getByRole("button", { name: /Use my authenticator app/i }));
    fill(/Handle or email/i, "alice");
    typeCode("654321");
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    await waitFor(() => screen.getByRole("button", { name: /Add a passkey/i }));
  }

  it("routes straight into passkey enrolment and says what the session is", async () => {
    mountFull();
    await reachEnrolment();

    // No menu, no other action: one button, and copy that explains why the
    // user is not simply signed in.
    expect(screen.getByText(/recovery session/i)).toBeTruthy();
    expect(screen.getByText(/add a passkey to this account/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Use a recovery code/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Email me a code/i })).toBeNull();
  });

  it("enrols with the held bearer and no step-up token", async () => {
    mountFull();
    await reachEnrolment();
    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));

    await waitFor(() =>
      expect(registration.passkeyRegisterBegin).toHaveBeenCalledWith({
        profileId: "usr_1",
        accessToken: ACCESS_TOKEN,
      }),
    );
    // A recovery-audience caller is admitted past the step-up gate on the
    // factor its session recorded. Sending a token would be wrong, and there
    // is none to send.
    expect(registration.passkeyRegisterBegin.mock.calls[0]![0]).not.toHaveProperty("stepUpToken");
    await waitFor(() => expect(registration.passkeyRegisterComplete).toHaveBeenCalled());
  });

  it("never adopts the restricted session, before or after enrolment", async () => {
    mountFull();
    await reachEnrolment();
    expect(hoisted.adoptSession).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
    await waitFor(() => expect(screen.getByText(/You're back in/i)).toBeTruthy());

    // The held token has the recovery audience and `/complete` returns no new
    // token set, so publishing it would announce a signed-in user whose token
    // every ordinary route rejects.
    expect(hoisted.adoptSession).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /Sign in with your new passkey/i })).toBeTruthy();
  });

  it("gives a timed-out session its own screen rather than a generic error", async () => {
    vi.useFakeTimers();
    try {
      stub.totpRecoveryComplete.mockResolvedValue({
        // Already expired when it arrives.
        session: { ...restrictedSession, expiresAt: Date.now() },
        profile: sampleProfile,
      });
      mountFull();
      fireEvent.click(screen.getByRole("button", { name: /Use my authenticator app/i }));
      fill(/Handle or email/i, "alice");
      typeCode("654321");
      fireEvent.click(screen.getByRole("button", { name: /Continue/i }));

      await vi.waitFor(() => expect(stub.totpRecoveryComplete).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(1000);

      // Somebody who has just proved who they are and then meets a bare 401
      // concludes the product is broken. This is its own state, with its own
      // words and a way onward.
      expect(screen.getByText(/timed out/i)).toBeTruthy();
      expect(screen.getByText(/Nothing has gone wrong/i)).toBeTruthy();
      expect(screen.getByRole("button", { name: /Start again/i })).toBeTruthy();
      expect(screen.queryByRole("button", { name: /Add a passkey/i })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers a retry and a way out when the ceremony fails", async () => {
    registration.passkeyRegisterBegin.mockRejectedValue(new Error("NotAllowedError"));
    mountFull();
    await reachEnrolment();
    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/NotAllowedError/);
    expect(screen.getByRole("button", { name: /Try again/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Start again/i })).toBeTruthy();
  });
});
