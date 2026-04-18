// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

/**
 * Recovery-code login form. Tests cover:
 *  - submit → client.loginWithRecoveryCode → adoptSession → onSuccess
 *  - error path surfaces the generic "didn't work" message (no enumeration
 *    oracle leakage) and keeps the form usable
 *  - Sign-in button is disabled until both fields are populated
 *  - Cancel button invokes onCancel when supplied
 */

const hoisted = vi.hoisted(() => ({
  adoptSession: vi.fn(),
}));

vi.mock("@osn/client/solid", () => ({
  useAuth: () => ({
    adoptSession: hoisted.adoptSession,
  }),
}));

import type { RecoveryClient } from "@osn/client";

import { RecoveryLoginForm } from "../../src/auth/RecoveryLoginForm";

interface ClientStub {
  generateRecoveryCodes: ReturnType<typeof vi.fn>;
  loginWithRecoveryCode: ReturnType<typeof vi.fn>;
}

function makeClientStub(): ClientStub {
  return {
    generateRecoveryCodes: vi.fn(),
    loginWithRecoveryCode: vi.fn(),
  };
}

const asClient = (s: ClientStub): RecoveryClient => s as unknown as RecoveryClient;

const sampleSession = {
  accessToken: "acc_x",
  refreshToken: null,
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

let stub: ClientStub;

function fill(label: RegExp, value: string) {
  const input = screen.getByLabelText(label) as HTMLInputElement;
  fireEvent.input(input, { target: { value } });
  return input;
}

describe("RecoveryLoginForm", () => {
  beforeEach(() => {
    stub = makeClientStub();
    hoisted.adoptSession.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("submit button is disabled until both fields are populated", () => {
    render(() => <RecoveryLoginForm client={asClient(stub)} />);
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
    render(() => <RecoveryLoginForm client={asClient(stub)} onSuccess={onSuccess} />);

    fill(/Handle or email/i, "alice@example.com");
    fill(/Recovery code/i, "abcd-1234-5678-ef00");
    fireEvent.click(screen.getByRole("button", { name: /Sign in with recovery code/i }));

    await waitFor(() => {
      expect(stub.loginWithRecoveryCode).toHaveBeenCalledWith({
        identifier: "alice@example.com",
        code: "abcd-1234-5678-ef00",
      });
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
    render(() => <RecoveryLoginForm client={asClient(stub)} />);

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
    render(() => <RecoveryLoginForm client={asClient(stub)} />);

    fill(/Handle or email/i, "nobody@example.com");
    fill(/Recovery code/i, "wrng-wrng-wrng-wrng");
    fireEvent.click(screen.getByRole("button", { name: /Sign in with recovery code/i }));

    await waitFor(() => {
      expect(screen.getByText(/That recovery code didn't work/i)).toBeTruthy();
    });
    expect(screen.queryByText(/User does not exist/)).toBeNull();

    // adoptSession never fires on failure.
    expect(hoisted.adoptSession).not.toHaveBeenCalled();

    // The submit button is interactive again (not stuck in busy state).
    const submit = screen.getByRole("button", {
      name: /Sign in with recovery code/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);
  });

  it("renders and invokes onCancel when provided", () => {
    const onCancel = vi.fn();
    render(() => <RecoveryLoginForm client={asClient(stub)} onCancel={onCancel} />);

    fireEvent.click(screen.getByRole("button", { name: /Cancel/i }));
    expect(onCancel).toHaveBeenCalled();
  });
});
