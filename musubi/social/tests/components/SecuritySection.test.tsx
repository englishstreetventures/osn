// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Settings → Security is the only place a user can reach the authenticator-app
 * surface, so an unmounted `<TotpView>` is a feature nobody can find — the
 * exact half of this work most likely to be skipped, and the half no unit test
 * of the component itself would notice.
 *
 * The three views are stubbed: what is under test is the wiring, not their
 * internals, which have their own tests in `@osn/ui`.
 */

const props = vi.hoisted(() => ({
  passkeys: {} as Record<string, unknown>,
  totp: {} as Record<string, unknown>,
  recoveryCodes: {} as Record<string, unknown>,
}));

vi.mock("@osn/ui/auth/PasskeysView", () => ({
  PasskeysView: (p: Record<string, unknown>) => {
    Object.assign(props.passkeys, p);
    return <div data-testid="passkeys" />;
  },
}));
vi.mock("@osn/ui/auth/TotpView", () => ({
  TotpView: (p: Record<string, unknown>) => {
    Object.assign(props.totp, p);
    return <div data-testid="totp" />;
  },
}));
vi.mock("@osn/ui/auth/RecoveryCodesView", () => ({
  RecoveryCodesView: (p: Record<string, unknown>) => {
    Object.assign(props.recoveryCodes, p);
    return <div data-testid="recovery-codes" />;
  },
}));

const clients = vi.hoisted(() => ({
  passkeysClient: { kind: "passkeys" },
  recoveryClient: { kind: "recovery" },
  stepUpClient: { kind: "stepUp" },
  totpClient: { kind: "totp" },
}));

vi.mock("../../src/lib/authClients", () => clients);
vi.mock("../../src/lib/webauthn-ceremony", () => ({ runPasskeyCeremony: () => {} }));
vi.mock("../../src/lib/webauthn-registration", () => ({ runPasskeyRegistration: () => {} }));

import SecuritySection from "../../src/components/SecuritySection";

afterEach(() => cleanup());

describe("SecuritySection", () => {
  it("mounts all three ways in and back into an account", () => {
    render(() => <SecuritySection accessToken="acc" profileId="prof_1" />);
    expect(screen.getByTestId("passkeys")).toBeTruthy();
    // Without this the authenticator-app work ships unreachable.
    expect(screen.getByTestId("totp")).toBeTruthy();
    expect(screen.getByTestId("recovery-codes")).toBeTruthy();
  });

  it("gives the authenticator surface the clients and token it needs", () => {
    render(() => <SecuritySection accessToken="acc" profileId="prof_1" />);
    expect(props.totp.client).toBe(clients.totpClient);
    expect(props.totp.stepUpClient).toBe(clients.stepUpClient);
    expect(props.totp.accessToken).toBe("acc");
    // Enrolling and removing are both step-up gated, and a passkey is the
    // factor every one of those gates accepts.
    expect(typeof props.totp.runPasskeyCeremony).toBe("function");
  });

  it("offers the authenticator as a step-up factor on the surfaces that admit it", () => {
    render(() => <SecuritySection accessToken="acc" profileId="prof_1" />);
    // `passkey_register` and `recovery_generate` both admit a `totp` AMR, so
    // a user whose passkey is on a lost device can still act here.
    expect(props.passkeys.totpClient).toBe(clients.totpClient);
    expect(props.recoveryCodes.totpClient).toBe(clients.totpClient);
  });
});
