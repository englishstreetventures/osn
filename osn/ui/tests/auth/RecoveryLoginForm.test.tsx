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
  refreshHeldSession: vi.fn(),
  webauthnSupported: true,
}));

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    adoptSession: hoisted.adoptSession,
    refreshHeldSession: hoisted.refreshHeldSession,
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
  hoisted.refreshHeldSession.mockReset();
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

/**
 * Keeping the held session alive.
 *
 * The session row lives fifteen minutes; the access token in the same response
 * is signed with the ordinary five-minute TTL, and holding the session puts
 * this flow outside `authFetch`, where the silent refresh lives. So the screen
 * redeems the refresh cookie itself.
 *
 * Every case here drives `setTimeout`, so they all run on fake timers and use
 * `vi.waitFor` rather than the testing-library one — RTL's polls on the faked
 * `setTimeout` and never advances.
 */
describe("RecoveryLoginForm — keeping the restricted session alive", () => {
  const TTL_MS = 300_000;
  const LEAD_MS = 30_000;

  /** A session `ms` from expiry, measured from the current (faked) clock. */
  function sessionExpiringIn(ms: number, token = ACCESS_TOKEN) {
    return { accessToken: token, idToken: null, expiresAt: Date.now() + ms, scopes: [] };
  }

  /**
   * What `refreshHeldSession` actually resolves to — the session wrapped in
   * `HeldSession`, never bare. Mirrors the real `@osn/client` contract, so a
   * test that drives this mock exercises the same `{ session } = await …`
   * destructuring shape the component reads.
   */
  function heldSessionExpiringIn(ms: number, token = ACCESS_TOKEN) {
    return { held: true as const, session: sessionExpiringIn(ms, token) };
  }

  /**
   * A grant that mints its token when it is called, not when it is set up.
   * `mockResolvedValue` would freeze `expiresAt` at test-setup time, so after
   * the clock advanced the "fresh" token would arrive already stale — the
   * opposite of what the issuer does.
   */
  function grantsTokenExpiringIn(ms: number, token: string) {
    return () => Promise.resolve(heldSessionExpiringIn(ms, token));
  }

  /** A promise the test resolves by hand, for asserting on an in-flight grant. */
  function deferred<T>() {
    let settle!: (value: T) => void;
    let fail!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      settle = res;
      fail = rej;
    });
    return { promise, settle, fail };
  }

  /** Drives the TOTP factor through to the enrolment screen holding `session`. */
  async function reachEnrolmentHolding(session: ReturnType<typeof sessionExpiringIn>) {
    stub.totpRecoveryComplete.mockResolvedValue({ session, profile: sampleProfile });
    mountFull();
    fireEvent.click(screen.getByRole("button", { name: /Use my authenticator app/i }));
    fill(/Handle or email/i, "alice");
    typeCode("654321");
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    await vi.waitFor(() => screen.getByRole("button", { name: /Add a passkey/i }));
  }

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("refreshes before the token expires and enrols with the token it got back", async () => {
    // The whole point of the change: at ten minutes the old build had been dead
    // for five, and the button sent a bearer the issuer had stopped honouring.
    hoisted.refreshHeldSession.mockImplementation(grantsTokenExpiringIn(TTL_MS, "acc_refreshed"));
    await reachEnrolmentHolding(sessionExpiringIn(TTL_MS));

    await vi.advanceTimersByTimeAsync(TTL_MS - LEAD_MS);
    expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1);

    // Well past the original five minutes, and still usable.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(screen.getByRole("button", { name: /Add a passkey/i })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
    await vi.waitFor(() => expect(registration.passkeyRegisterBegin).toHaveBeenCalled());
    expect(registration.passkeyRegisterBegin.mock.calls[0]![0].accessToken).toBe("acc_refreshed");
  });

  it("stops granting once the issuer caps a token inside the refresh lead", async () => {
    // The issuer caps a restricted session's token at the life its row has
    // left, so a token arriving with less than the lead on it IS the deadline.
    // Asking again would return the same instant; waiting it out is the end of
    // the window, and it needs no copy of the server's fifteen minutes here.
    await reachEnrolmentHolding(sessionExpiringIn(20_000));

    await vi.advanceTimersByTimeAsync(19_000);
    expect(screen.getByRole("button", { name: /Add a passkey/i })).toBeTruthy();

    await vi.advanceTimersByTimeAsync(2_000);
    expect(hoisted.refreshHeldSession).not.toHaveBeenCalled();
    expect(screen.getByText(/timed out/i)).toBeTruthy();
  });

  it("survives a transient refusal instead of ending the session ten minutes early", async () => {
    // `@osn/client` gives up after ~0.6s of retries and reports a cold isolate
    // exactly like a dead cookie. Treating the first refusal as final would
    // hand back the window this change exists to give.
    hoisted.refreshHeldSession
      .mockRejectedValueOnce(new Error("503"))
      .mockImplementation(grantsTokenExpiringIn(TTL_MS, "acc_second_try"));
    await reachEnrolmentHolding(sessionExpiringIn(TTL_MS));

    await vi.advanceTimersByTimeAsync(TTL_MS - LEAD_MS);
    expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(LEAD_MS);
    expect(hoisted.refreshHeldSession.mock.calls.length).toBeGreaterThan(1);
    expect(screen.getByRole("button", { name: /Add a passkey/i })).toBeTruthy();
  });

  it("shows the timed-out screen once the grant is refused for good", async () => {
    hoisted.refreshHeldSession.mockRejectedValue(new Error("invalid_grant"));
    await reachEnrolmentHolding(sessionExpiringIn(TTL_MS));

    await vi.advanceTimersByTimeAsync(TTL_MS + 60_000);
    expect(screen.getByText(/timed out/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add a passkey/i })).toBeNull();
  });

  it("refreshes before completing a ceremony that outlived its token", async () => {
    // A WebAuthn challenge lives two minutes; the refresh lead is thirty
    // seconds. So a prompt begun just before a scheduled grant routinely
    // outlives the token it started with, and `/complete` would send a dead
    // bearer — the failure in this issue's title, reached by a different road.
    const ceremony = deferred<never>();
    hoisted.refreshHeldSession.mockImplementation(
      grantsTokenExpiringIn(TTL_MS, "acc_mid_ceremony"),
    );
    stub.totpRecoveryComplete.mockResolvedValue({
      session: sessionExpiringIn(TTL_MS),
      profile: sampleProfile,
    });
    render(() => (
      <RecoveryLoginForm
        client={asClient(stub)}
        registrationClient={asRegistration(registration)}
        runPasskeyRegistration={() => ceremony.promise}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: /Use my authenticator app/i }));
    fill(/Handle or email/i, "alice");
    typeCode("654321");
    fireEvent.click(screen.getByRole("button", { name: /Continue/i }));
    await vi.waitFor(() => screen.getByRole("button", { name: /Add a passkey/i }));

    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
    await vi.waitFor(() => expect(registration.passkeyRegisterBegin).toHaveBeenCalled());
    expect(registration.passkeyRegisterBegin.mock.calls[0]![0].accessToken).toBe(ACCESS_TOKEN);

    // The user is still at their authenticator while the token dies.
    await vi.advanceTimersByTimeAsync(TTL_MS);
    ceremony.settle(attestation as never);

    await vi.waitFor(() => expect(registration.passkeyRegisterComplete).toHaveBeenCalled());
    expect(registration.passkeyRegisterComplete.mock.calls[0]![0].accessToken).toBe(
      "acc_mid_ceremony",
    );
  });

  it("abandons a grant that resolves after Start again", async () => {
    // Clearing the timer does not stop a grant already on the wire, and its
    // continuation arms the next one. Without a generation guard this re-holds
    // a token from a family the new factor has already deleted, and rotates the
    // session for as long as the page is open.
    const grant = deferred<ReturnType<typeof heldSessionExpiringIn>>();
    hoisted.refreshHeldSession.mockReturnValue(grant.promise);
    // A failed ceremony is what puts "Start again" on the enrolment screen.
    registration.passkeyRegisterBegin.mockRejectedValue(new Error("NotAllowedError"));
    await reachEnrolmentHolding(sessionExpiringIn(TTL_MS));

    // Fails on the token it already holds, so no grant is spent getting here.
    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
    await vi.waitFor(() => screen.getByRole("button", { name: /Start again/i }));
    expect(hoisted.refreshHeldSession).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(TTL_MS - LEAD_MS);
    expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: /Start again/i }));
    grant.settle(heldSessionExpiringIn(TTL_MS, "acc_stale"));
    await vi.advanceTimersByTimeAsync(TTL_MS * 3);

    expect(screen.getByRole("button", { name: /Use a recovery code/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Add a passkey/i })).toBeNull();
    // Still the one grant: nothing re-armed.
    expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1);
  });

  it("abandons a grant that resolves after enrolment succeeds", async () => {
    // The highest-consequence transition: after a successful recovery the
    // user holds an ORDINARY session, which the issuer never refuses — so a
    // background grant that resolves after this epoch bump and is applied
    // rather than discarded would re-arm a refresh loop with no stop
    // condition at all.
    //
    // `passkeyRegisterComplete` is held open so a background refresh can
    // queue up (and be genuinely dispatched) behind it: both of
    // `enrolPasskey`'s own token reads are comfortably inside the lead here,
    // so it never spends a grant of its own — the one call below is the
    // background timer's, and it lands only once `/complete` has already
    // resolved and epoch has already moved on.
    const grant = deferred<ReturnType<typeof heldSessionExpiringIn>>();
    hoisted.refreshHeldSession.mockReturnValue(grant.promise);
    const complete = deferred<{ passkeyId: string }>();
    registration.passkeyRegisterComplete.mockReturnValue(complete.promise);
    await reachEnrolmentHolding(sessionExpiringIn(TTL_MS));

    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
    await vi.waitFor(() => expect(registration.passkeyRegisterComplete).toHaveBeenCalled());

    // The background timer fires while `/complete` is still on the wire. Its
    // grant takes a place in the queue but isn't dispatched yet.
    await vi.advanceTimersByTimeAsync(TTL_MS - LEAD_MS);
    expect(hoisted.refreshHeldSession).not.toHaveBeenCalled();

    // `/complete` resolves: enrolPasskey bumps epoch and clears `held`.
    // Only then does the queued grant get dispatched — genuinely in flight
    // against a session that, by the time it lands, no longer exists.
    complete.settle({ passkeyId: "pk_new" });
    await vi.waitFor(() => expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1));
    expect(screen.getByText(/You're back in/i)).toBeTruthy();

    // Settling it now must be a no-op.
    grant.settle(heldSessionExpiringIn(TTL_MS, "acc_late"));
    await vi.advanceTimersByTimeAsync(TTL_MS * 3);

    expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/You're back in/i)).toBeTruthy();
  });

  it("abandons a grant that resolves after the screen unmounts", async () => {
    // The worst version: after enrolment the user signs in, so the cookie names
    // an ORDINARY session, which the issuer never refuses. A loop re-armed here
    // has no stop condition at all.
    const grant = deferred<ReturnType<typeof heldSessionExpiringIn>>();
    hoisted.refreshHeldSession.mockReturnValue(grant.promise);
    await reachEnrolmentHolding(sessionExpiringIn(TTL_MS));

    await vi.advanceTimersByTimeAsync(TTL_MS - LEAD_MS);
    expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1);

    cleanup();
    grant.settle(heldSessionExpiringIn(TTL_MS, "acc_orphan"));
    await vi.advanceTimersByTimeAsync(TTL_MS * 3);

    expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1);
  });

  it("abandons a grant that resolves after unmount mid-ceremony", async () => {
    // `freshToken()` has its own `if (mine !== epoch) return null;`, separate
    // from `refreshHeld`'s — triggered on demand from the ceremony rather
    // than the background timer, so it needs its own proof. Minting already
    // inside the lead means `beginRestricted` arms an expiry timer, not a
    // refresh one, so the one grant possible here is the one `freshToken()`
    // requests when `enrolPasskey` clicks — isolating it from the background
    // path the other two tests in this block cover.
    const grant = deferred<ReturnType<typeof heldSessionExpiringIn>>();
    hoisted.refreshHeldSession.mockReturnValue(grant.promise);
    await reachEnrolmentHolding(sessionExpiringIn(LEAD_MS - 5_000));

    fireEvent.click(screen.getByRole("button", { name: /Add a passkey/i }));
    await vi.waitFor(() => expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1));
    // Still waiting on the grant — the ceremony itself never started.
    expect(registration.passkeyRegisterBegin).not.toHaveBeenCalled();

    cleanup();
    grant.settle(heldSessionExpiringIn(TTL_MS, "acc_orphan_ceremony"));
    await vi.advanceTimersByTimeAsync(TTL_MS * 3);

    // Discarded: `freshToken()` returns null, `enrolPasskey` never asks for
    // a ceremony, and nothing re-requests a grant.
    expect(registration.passkeyRegisterBegin).not.toHaveBeenCalled();
    expect(hoisted.refreshHeldSession).toHaveBeenCalledTimes(1);
  });
});
