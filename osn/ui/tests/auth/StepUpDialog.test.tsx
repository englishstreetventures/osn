// @vitest-environment happy-dom
import type { StepUpClient, StepUpPurpose, StepUpToken, TotpClient } from "@osn/client";
import type { AuthenticationResponseJSON } from "@simplewebauthn/browser";
import { render, cleanup, screen, fireEvent, waitFor, within } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { StepUpDialog } from "../../src/auth/StepUpDialog";

interface ClientStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
  totpComplete: ReturnType<typeof vi.fn>;
}

function makeStub(): ClientStub {
  return {
    passkeyBegin: vi.fn(),
    passkeyComplete: vi.fn(),
    otpBegin: vi.fn(),
    otpComplete: vi.fn(),
    totpComplete: vi.fn(),
  };
}

const asClient = (s: ClientStub): StepUpClient => s as unknown as StepUpClient;

/**
 * A minimal but well-formed WebAuthn assertion. The dialog never reads a
 * field off it — it goes straight to `passkeyComplete` — so the values only
 * need to satisfy the shape the browser really returns.
 */
const assertion: AuthenticationResponseJSON = {
  id: "cred",
  rawId: "cred",
  response: {
    clientDataJSON: "Y2xpZW50RGF0YQ",
    authenticatorData: "YXV0aERhdGE",
    signature: "c2ln",
  },
  clientExtensionResults: {},
  type: "public-key",
};

let stub: ClientStub;

// Module-level so every describe below gets a fresh stub, not only the first.
beforeEach(() => {
  stub = makeStub();
});
afterEach(() => cleanup());

describe("StepUpDialog", () => {
  it("OTP path: begin then complete calls onToken with the minted token", async () => {
    stub.otpBegin.mockResolvedValue({ sent: true });
    stub.otpComplete.mockResolvedValue({ token: "eyJ123", expiresIn: 300 });

    const onToken = vi.fn();
    const onCancel = vi.fn();
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        accessToken="acc"
        onToken={onToken}
        onCancel={onCancel}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Email me a code/ }));
    await waitFor(() => expect(stub.otpBegin).toHaveBeenCalled());

    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() => expect(onToken).toHaveBeenCalledWith({ token: "eyJ123", expiresIn: 300 }));
  });

  it("passkey path: runs caller-supplied ceremony and exchanges the assertion", async () => {
    stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
    stub.passkeyComplete.mockResolvedValue({ token: "eyJpk", expiresIn: 300 });
    const runPasskey = vi.fn(async () => assertion);

    const onToken = vi.fn();
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        accessToken="acc"
        onToken={onToken}
        onCancel={() => {}}
        runPasskeyCeremony={runPasskey}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Use passkey/ }));
    await waitFor(() => expect(runPasskey).toHaveBeenCalled());
    await waitFor(() => expect(onToken).toHaveBeenCalledWith({ token: "eyJpk", expiresIn: 300 }));
  });

  it("OTP complete failure surfaces the error message", async () => {
    stub.otpBegin.mockResolvedValue({ sent: true });
    stub.otpComplete.mockRejectedValue(new Error("Invalid or expired code"));

    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        accessToken="acc"
        onToken={() => {}}
        onCancel={() => {}}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Email me a code/ }));
    const input = await screen.findByRole("textbox");
    fireEvent.input(input, { target: { value: "000000" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
    await waitFor(() => expect(screen.getByText(/Invalid or expired code/)).toBeTruthy());
  });

  // passkeyOnly: the "Email me a code" OTP factor is hidden entirely. Used by
  // the cire organiser portal where transactional email is degraded
  // (OSN_EMAIL_OPTIONAL=true), so an OTP step-up would dead-end the user. The
  // passkey ceremony starts immediately on mount — no factor picker.
  it("passkeyOnly: hides the OTP option and auto-starts the passkey ceremony", async () => {
    stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
    stub.passkeyComplete.mockResolvedValue({ token: "eyJpk", expiresIn: 300 });
    const runPasskey = vi.fn(async () => assertion);
    const onToken = vi.fn();

    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        accessToken="acc"
        onToken={onToken}
        onCancel={() => {}}
        runPasskeyCeremony={runPasskey}
        passkeyOnly
      />
    ));

    // No OTP affordance at all.
    expect(screen.queryByRole("button", { name: /Email me a code/i })).toBeNull();
    // Ceremony fires without the user clicking "Use passkey".
    await waitFor(() => expect(runPasskey).toHaveBeenCalled());
    await waitFor(() => expect(onToken).toHaveBeenCalledWith({ token: "eyJpk", expiresIn: 300 }));
    expect(stub.otpBegin).not.toHaveBeenCalled();
  });

  it("passkeyOnly: surfaces a retry affordance when the ceremony fails", async () => {
    stub.passkeyBegin.mockResolvedValue({ options: { challenge: "abc" } });
    const runPasskey = vi.fn().mockRejectedValue(new Error("NotAllowedError"));

    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        accessToken="acc"
        onToken={() => {}}
        onCancel={() => {}}
        runPasskeyCeremony={runPasskey}
        passkeyOnly
      />
    ));

    await waitFor(() => expect(screen.getByText(/NotAllowedError/)).toBeTruthy());
    // A retry button is available (passkey factor, not the choose menu).
    expect(screen.getByRole("button", { name: /Try again|Use passkey/i })).toBeTruthy();
  });

  it("announces the failure rather than leaving it to be noticed", async () => {
    stub.otpBegin.mockRejectedValue(new Error("Could not send code"));

    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        accessToken="acc"
        onToken={() => {}}
        onCancel={() => {}}
      />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Email me a code/ }));
    // A step-up failure is why the user cannot proceed. Rendering it in a
    // coloured paragraph tells a sighted user only.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(/Could not send code/);
  });
});

/**
 * The authenticator-app factor.
 *
 * Two independent conditions gate it, and each fails differently if dropped:
 * the account must have a confirmed credential (otherwise the dialog offers a
 * factor that cannot produce a code), and the ceremony's own allow-list must
 * admit `totp` (otherwise it mints a token the gated call refuses). Both are
 * checked below.
 */
describe("StepUpDialog — authenticator app factor", () => {
  const TOTP_BUTTON = /Use your authenticator app/i;

  function totpStub(status: { enrolled: boolean } | Error) {
    return {
      status:
        status instanceof Error
          ? vi.fn().mockRejectedValue(status)
          : vi.fn().mockResolvedValue({
              enrolled: status.enrolled,
              label: "iPhone",
              lastUsedAt: null,
              createdAt: 1_700_000_000,
            }),
    };
  }

  const asTotp = (s: { status: ReturnType<typeof vi.fn> }): TotpClient =>
    s as unknown as TotpClient;

  function mount(overrides: {
    totp?: { status: ReturnType<typeof vi.fn> };
    purpose?: StepUpPurpose;
    passkeyOnly?: boolean;
    onToken?: (t: StepUpToken) => void;
  }) {
    render(() => (
      <StepUpDialog
        client={asClient(stub)}
        accessToken="acc"
        onToken={overrides.onToken ?? (() => {})}
        onCancel={() => {}}
        runPasskeyCeremony={async () => assertion}
        totpClient={overrides.totp ? asTotp(overrides.totp) : undefined}
        purpose={overrides.purpose}
        passkeyOnly={overrides.passkeyOnly}
      />
    ));
  }

  /**
   * Mounts the dialog under test beside one that DOES admit the
   * authenticator (enrolled, no error), and waits for that companion's
   * button to appear before returning the one under test.
   *
   * Asserting the factor's absence on its own — even inside `waitFor` —
   * cannot fail: whether it renders depends on the `GET /totp/status`
   * resource settling, and `waitFor`'s first check runs synchronously,
   * before that resource has had a single microtask to resolve. A
   * `queryByRole(...).toBeNull()` that is already true at that instant
   * resolves on the spot, whatever the guard would eventually decide — the
   * same failure mode a bare check has, just with extra ceremony. Both
   * dialogs' resources resolve on the same microtask cadence, so once the
   * admitting one has painted its button, the one under test has had its
   * chance too.
   */
  async function mountBesideAnAdmittingCeremony(overrides: {
    totp?: { status: ReturnType<typeof vi.fn> };
    purpose?: StepUpPurpose;
  }) {
    render(() => (
      <>
        <div data-testid="admits">
          <StepUpDialog
            client={asClient(stub)}
            accessToken="acc"
            onToken={() => {}}
            onCancel={() => {}}
            runPasskeyCeremony={async () => assertion}
            totpClient={asTotp(totpStub({ enrolled: true }))}
            purpose={overrides.purpose}
          />
        </div>
        <div data-testid="under-test">
          <StepUpDialog
            client={asClient(stub)}
            accessToken="acc"
            onToken={() => {}}
            onCancel={() => {}}
            runPasskeyCeremony={async () => assertion}
            totpClient={overrides.totp ? asTotp(overrides.totp) : undefined}
            purpose={overrides.purpose}
          />
        </div>
      </>
    ));
    const admits = within(screen.getByTestId("admits"));
    await waitFor(() => expect(admits.getByRole("button", { name: TOTP_BUTTON })).toBeTruthy());
    return within(screen.getByTestId("under-test"));
  }

  it("offers the factor when the account has a confirmed credential", async () => {
    mount({ totp: totpStub({ enrolled: true }), purpose: "recovery_generate" });
    expect(await screen.findByRole("button", { name: TOTP_BUTTON })).toBeTruthy();
  });

  it("hides the factor when the account has no confirmed credential", async () => {
    const underTest = await mountBesideAnAdmittingCeremony({
      totp: totpStub({ enrolled: false }),
      purpose: "recovery_generate",
    });
    expect(underTest.queryByRole("button", { name: TOTP_BUTTON })).toBeNull();
  });

  it("hides the factor when no TOTP client is supplied at all", async () => {
    mount({ purpose: "recovery_generate" });
    await waitFor(() => screen.getByRole("button", { name: /Use passkey/i }));
    expect(screen.queryByRole("button", { name: TOTP_BUTTON })).toBeNull();
  });

  it("keeps the other factors when the status read fails", async () => {
    // Whether an authenticator exists is not worth failing a ceremony over.
    const underTest = await mountBesideAnAdmittingCeremony({
      totp: totpStub(new Error("network")),
      purpose: "recovery_generate",
    });
    expect(underTest.getByRole("button", { name: /Use passkey/i })).toBeTruthy();
    expect(underTest.getByRole("button", { name: /Email me a code/i })).toBeTruthy();
    expect(underTest.queryByRole("button", { name: TOTP_BUTTON })).toBeNull();
  });

  it("exchanges a code for a token bound to the ceremony", async () => {
    stub.totpComplete.mockResolvedValue({ token: "eyJtotp", expiresIn: 300 });
    const onToken = vi.fn();
    mount({ totp: totpStub({ enrolled: true }), purpose: "recovery_generate", onToken });

    fireEvent.click(await screen.findByRole("button", { name: TOTP_BUTTON }));
    const input = await screen.findByLabelText(/Code from your authenticator app/i);
    fireEvent.input(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() =>
      expect(stub.totpComplete).toHaveBeenCalledWith({
        accessToken: "acc",
        code: "123456",
        purpose: "recovery_generate",
      }),
    );
    expect(onToken).toHaveBeenCalledWith({ token: "eyJtotp", expiresIn: 300 });
    // TOTP is challenge-free: there is no `begin` half to call.
    expect(stub.otpBegin).not.toHaveBeenCalled();
  });

  it("survives passkeyOnly, because an authenticator code needs no delivery", async () => {
    // `passkeyOnly` means "this host cannot deliver mail". A TOTP code is not
    // delivered, so it cannot dead-end the way the prop exists to prevent.
    mount({ totp: totpStub({ enrolled: true }), purpose: "recovery_generate", passkeyOnly: true });
    expect(await screen.findByRole("button", { name: TOTP_BUTTON })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Email me a code/i })).toBeNull();
  });
});

/**
 * A factor the gated endpoint will refuse is not a smaller menu, it is a dead
 * end: the ceremony succeeds, a token is minted, and the call it was minted
 * for fails. These pin the two ceremonies whose allow-lists are narrower than
 * the rest.
 */
describe("StepUpDialog — factors the ceremony would refuse", () => {
  const asTotp = (s: object): TotpClient => s as TotpClient;
  const TOTP_BUTTON = /Use your authenticator app/i;

  function totpClient() {
    return asTotp({
      status: async () => ({
        enrolled: true,
        label: "iPhone",
        lastUsedAt: null,
        createdAt: 1_700_000_000,
      }),
    });
  }

  function dialog(purpose: StepUpPurpose) {
    return (
      <StepUpDialog
        client={asClient(stub)}
        accessToken="acc"
        onToken={() => {}}
        onCancel={() => {}}
        runPasskeyCeremony={async () => assertion}
        totpClient={totpClient()}
        purpose={purpose}
      />
    );
  }

  /**
   * Mounts the ceremony under test beside one that DOES admit the
   * authenticator, and waits for the factor to appear in that one.
   *
   * Asserting the factor's absence on its own cannot fail: whether it renders
   * depends on a `GET /totp/status` resource, so a bare `queryByRole` runs
   * before the fetch resolves and passes whether or not the guard exists.
   * Both dialogs read the same already-resolved status, so once the admitting
   * one has painted the button, the refusing one has had its chance.
   */
  async function mountBesideAnAdmittingCeremony(refusing: StepUpPurpose) {
    render(() => (
      <>
        <div data-testid="admits">{dialog("passkey_register")}</div>
        <div data-testid="refuses">{dialog(refusing)}</div>
      </>
    ));
    const admits = within(screen.getByTestId("admits"));
    await waitFor(() => expect(admits.getByRole("button", { name: TOTP_BUTTON })).toBeTruthy());
    return within(screen.getByTestId("refuses"));
  }

  it("passkey_delete offers neither code factor — the gate is WebAuthn-only", async () => {
    // `passkeyDeleteAllowedAmr` is `["webauthn"]`, and this purpose gates
    // rename as well as delete.
    const refuses = await mountBesideAnAdmittingCeremony("passkey_delete");
    expect(refuses.getByRole("button", { name: /Use passkey/i })).toBeTruthy();
    expect(refuses.queryByRole("button", { name: /Email me a code/i })).toBeNull();
    expect(refuses.queryByRole("button", { name: TOTP_BUTTON })).toBeNull();
  });

  it("email_change keeps the emailed code but not the authenticator", async () => {
    // The emailed code proves control of the CURRENT mailbox; an
    // authenticator seed does not, which is the whole point of that gate.
    const refuses = await mountBesideAnAdmittingCeremony("email_change");
    expect(refuses.getByRole("button", { name: /Email me a code/i })).toBeTruthy();
    expect(refuses.queryByRole("button", { name: TOTP_BUTTON })).toBeNull();
  });

  it("passkey_register admits both, so a lost device is not a lock-out", async () => {
    render(() => dialog("passkey_register"));
    expect(await screen.findByRole("button", { name: TOTP_BUTTON })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Email me a code/i })).toBeTruthy();
  });
});
