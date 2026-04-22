// @vitest-environment happy-dom
import type { PasskeysClient, StepUpClient, StepUpToken } from "@osn/client";
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { PasskeysView } from "../../src/auth/PasskeysView";

/**
 * Settings → Passkeys view (T-M1). Covers the orchestration logic that
 * isn't exercised at the service / HTTP layer: list rendering, inline
 * rename, confirm-gated delete, and step-up threading into the delete
 * call. The `PasskeysClient` + `StepUpClient` are stubbed so we assert
 * on the wire-contract rather than real network calls.
 */

interface PasskeysStub {
  list: ReturnType<typeof vi.fn>;
  rename: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
}

interface StepUpStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
}

const makePasskeys = (): PasskeysStub => ({
  list: vi.fn(),
  rename: vi.fn(),
  delete: vi.fn(),
});

const makeStepUp = (): StepUpStub => ({
  passkeyBegin: vi.fn(),
  passkeyComplete: vi.fn(),
  otpBegin: vi.fn(),
  otpComplete: vi.fn(),
});

const asPasskeys = (s: PasskeysStub): PasskeysClient => s as unknown as PasskeysClient;
const asStepUp = (s: StepUpStub): StepUpClient => s as unknown as StepUpClient;

const stepUpToken: StepUpToken = { token: "stpup_xxx", expiresIn: 300 };

const passkeyRows = [
  {
    id: "pk_aaaaaaaaaaaa",
    label: "Work laptop",
    aaguid: null,
    transports: null,
    backupEligible: false,
    backupState: false,
    createdAt: 1_700_000_000,
    lastUsedAt: 1_700_005_000,
  },
  {
    id: "pk_bbbbbbbbbbbb",
    label: null,
    aaguid: null,
    transports: null,
    backupEligible: true,
    backupState: true,
    createdAt: 1_700_000_100,
    lastUsedAt: null,
  },
];

let pk: PasskeysStub;
let su: StepUpStub;

describe("PasskeysView", () => {
  beforeEach(() => {
    pk = makePasskeys();
    su = makeStepUp();
    // Confirm dialog defaults to approve — individual tests override.
    window.confirm = () => true;
  });

  afterEach(() => cleanup());

  it("renders the passkey list with user labels and friendly fallbacks", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    render(() => (
      <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} accessToken="acc" />
    ));

    await waitFor(() => {
      // First row: user-provided label.
      expect(screen.getByText(/Work laptop/)).toBeTruthy();
      // Second row: null label + backupEligible → "Synced passkey" fallback.
      expect(screen.getByText(/Synced passkey/)).toBeTruthy();
      expect(screen.getAllByText(/\(synced\)/)).toHaveLength(1);
    });
  });

  it("renames via step-up: editor → save → step-up dialog → client.rename with stepUpToken", async () => {
    pk.list.mockResolvedValueOnce({ passkeys: passkeyRows });
    pk.list.mockResolvedValueOnce({
      passkeys: [{ ...passkeyRows[0]!, label: "Primary" }, passkeyRows[1]!],
    });
    pk.rename.mockResolvedValue({ success: true });
    su.otpBegin.mockResolvedValue({ sent: true });
    su.otpComplete.mockResolvedValue(stepUpToken);

    render(() => (
      <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} accessToken="acc" />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Rename$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!);
    const input = screen.getByDisplayValue("Work laptop") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "  Primary  " } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));

    // Step-up dialog opens (S-M2). Use the OTP factor.
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));
    const codeInput = await waitFor(() => screen.getByLabelText(/code/i) as HTMLInputElement);
    fireEvent.input(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() =>
      expect(pk.rename).toHaveBeenCalledWith({
        accessToken: "acc",
        id: "pk_aaaaaaaaaaaa",
        label: "Primary",
        stepUpToken: stepUpToken.token,
      }),
    );
    expect(pk.list).toHaveBeenCalledTimes(2);
  });

  it("disables save when the draft label is empty / whitespace-only", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    render(() => (
      <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} accessToken="acc" />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Rename$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!);

    const input = screen.getByDisplayValue("Work laptop") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "   " } });
    const save = screen.getByRole("button", { name: /^Save$/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("delete flow: confirm → step-up → client.delete with stepUpToken → reload", async () => {
    pk.list.mockResolvedValueOnce({ passkeys: passkeyRows });
    pk.list.mockResolvedValueOnce({ passkeys: [passkeyRows[1]!] });
    pk.delete.mockResolvedValue({ success: true, remaining: 1 });
    su.otpBegin.mockResolvedValue({ sent: true });
    su.otpComplete.mockResolvedValue(stepUpToken);

    render(() => (
      <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} accessToken="acc" />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Delete$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Delete$/ })[0]!);

    // Dialog opens — use OTP factor so we don't need runPasskeyCeremony.
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));

    // Fill the code.
    const codeInput = await waitFor(() => screen.getByLabelText(/code/i) as HTMLInputElement);
    fireEvent.input(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() =>
      expect(pk.delete).toHaveBeenCalledWith({
        accessToken: "acc",
        id: "pk_aaaaaaaaaaaa",
        stepUpToken: stepUpToken.token,
      }),
    );
    // Reload after delete.
    expect(pk.list).toHaveBeenCalledTimes(2);
  });

  it("delete is skipped entirely if the user dismisses confirm()", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    window.confirm = () => false;
    render(() => (
      <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} accessToken="acc" />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Delete$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Delete$/ })[0]!);

    // No step-up prompt, no delete call, no reload.
    expect(su.otpBegin).not.toHaveBeenCalled();
    expect(pk.delete).not.toHaveBeenCalled();
  });

  it("surfaces rename errors in a destructive banner", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    pk.rename.mockRejectedValue(new Error("Passkey not found"));
    su.otpBegin.mockResolvedValue({ sent: true });
    su.otpComplete.mockResolvedValue(stepUpToken);

    render(() => (
      <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} accessToken="acc" />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Rename$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Rename$/ })[0]!);
    const input = screen.getByDisplayValue("Work laptop") as HTMLInputElement;
    fireEvent.input(input, { target: { value: "New label" } });
    fireEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    // Drive the step-up to actually fire the rename call.
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));
    const codeInput = await waitFor(() => screen.getByLabelText(/code/i) as HTMLInputElement);
    fireEvent.input(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm/i }));

    await waitFor(() => expect(screen.getByText(/Passkey not found/)).toBeTruthy());
  });

  // S-L1: while a step-up is in flight, every Rename / Delete button on the
  // page is disabled to prevent a rapid double-click swapping the pending id.
  it("locks every Rename/Delete button while a step-up is in flight (S-L1)", async () => {
    pk.list.mockResolvedValue({ passkeys: passkeyRows });
    su.otpBegin.mockResolvedValue({ sent: true });

    render(() => (
      <PasskeysView client={asPasskeys(pk)} stepUpClient={asStepUp(su)} accessToken="acc" />
    ));

    await waitFor(() => screen.getAllByRole("button", { name: /^Delete$/ }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Delete$/ })[0]!);
    // Step-up dialog open — every Rename + Delete button on the list rows
    // must be disabled.
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/i }));
    const renameButtons = screen.getAllByRole("button", { name: /^Rename$/ });
    const deleteButtons = screen.getAllByRole("button", { name: /^Delete$/ });
    for (const b of [...renameButtons, ...deleteButtons]) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
  });
});
