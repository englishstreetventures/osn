// @vitest-environment happy-dom
import type { StepUpClient } from "@osn/client";
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { StepUpDialog } from "../../src/auth/StepUpDialog";

interface ClientStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
}

function makeStub(): ClientStub {
  return {
    passkeyBegin: vi.fn(),
    passkeyComplete: vi.fn(),
    otpBegin: vi.fn(),
    otpComplete: vi.fn(),
  };
}

const asClient = (s: ClientStub): StepUpClient => s as unknown as StepUpClient;

let stub: ClientStub;

describe("StepUpDialog", () => {
  beforeEach(() => {
    stub = makeStub();
  });

  afterEach(() => cleanup());

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
    const runPasskey = vi.fn(async () => ({ id: "cred", signed: true }));

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
    const runPasskey = vi.fn(async () => ({ id: "cred", signed: true }));
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
});
