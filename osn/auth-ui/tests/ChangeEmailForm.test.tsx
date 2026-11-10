// @vitest-environment happy-dom
import type { AccountClient, StepUpClient } from "@osn/client";
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ChangeEmailForm } from "../src/ChangeEmailForm";
import { CODE, DETAILS, WAIT, alertsText, apiError } from "./helpers/errors";

interface AccountStub {
  changeEmailBegin: ReturnType<typeof vi.fn>;
  changeEmailComplete: ReturnType<typeof vi.fn>;
}
interface StepUpStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
}

describe("ChangeEmailForm", () => {
  let account: AccountStub;
  let stepUp: StepUpStub;

  beforeEach(() => {
    account = {
      changeEmailBegin: vi.fn(),
      changeEmailComplete: vi.fn(),
    };
    stepUp = {
      passkeyBegin: vi.fn(),
      passkeyComplete: vi.fn(),
      otpBegin: vi.fn(),
      otpComplete: vi.fn(),
    };
  });

  afterEach(() => cleanup());

  it("runs the full begin → step-up → complete happy path", async () => {
    account.changeEmailBegin.mockResolvedValue({ sent: true });
    account.changeEmailComplete.mockResolvedValue({ email: "next@example.com" });
    stepUp.otpBegin.mockResolvedValue({ sent: true });
    stepUp.otpComplete.mockResolvedValue({ token: "eyJsu", expiresIn: 300 });

    const onChanged = vi.fn();
    render(() => (
      <ChangeEmailForm
        accountClient={account as unknown as AccountClient}
        stepUpClient={stepUp as unknown as StepUpClient}
        onChanged={onChanged}
      />
    ));

    // Phase 1: enter email.
    const emailInput = screen.getByRole("textbox");
    fireEvent.input(emailInput, { target: { value: "next@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }));
    await waitFor(() => expect(account.changeEmailBegin).toHaveBeenCalled());

    // Phase 2: enter OTP, triggers step-up modal on confirm.
    const otpInput = await screen.findByDisplayValue("");
    fireEvent.input(otpInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm identity/ }));

    // Step-up modal: pick OTP, enter code.
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/ }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/ }));
    const stepUpInput = await screen.findByRole("textbox");
    fireEvent.input(stepUpInput, { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() => expect(account.changeEmailComplete).toHaveBeenCalled());
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("next@example.com"));
  });

  function mount() {
    render(() => (
      <ChangeEmailForm
        accountClient={account as unknown as AccountClient}
        stepUpClient={stepUp as unknown as StepUpClient}
      />
    ));
  }

  it.each([
    ["a refusal", apiError("PLANTED-begin"), DETAILS, "true"],
    ["a 429", apiError("PLANTED-begin-429", 429, "rate_limited"), WAIT, null],
  ])(
    "reads %s to send the code under the email field, tied to it",
    async (_, error, sentence, invalid) => {
      account.changeEmailBegin.mockRejectedValue(error);
      mount();
      const emailInput = screen.getByLabelText("New email");
      fireEvent.input(emailInput, { target: { value: "next@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(sentence);
      expect(alertsText()).not.toContain("PLANTED");
      expect(emailInput.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
      expect(emailInput.getAttribute("aria-invalid")).toBe(invalid);
      expect(alert.closest("label")).toBeNull();
    },
  );

  // Both buttons hold focus through their wait: `busy`, not `disabled`.
  it("keeps Send verification code busy, not disabled, while it sends", async () => {
    account.changeEmailBegin.mockReturnValue(new Promise(() => {}));
    mount();
    fireEvent.input(screen.getByLabelText("New email"), { target: { value: "next@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }));
    const sending = await screen.findByRole("button", { name: "Sending…" });
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect((sending as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sending);
    await Promise.resolve();
    expect(account.changeEmailBegin).toHaveBeenCalledTimes(1);
  });

  it("keeps the confirm busy, not disabled, while it changes the email", async () => {
    account.changeEmailBegin.mockResolvedValue({ sent: true });
    account.changeEmailComplete.mockReturnValue(new Promise(() => {}));
    stepUp.otpBegin.mockResolvedValue({ sent: true });
    stepUp.otpComplete.mockResolvedValue({ token: "eyJsu", expiresIn: 300 });
    mount();
    fireEvent.input(screen.getByLabelText("New email"), { target: { value: "next@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }));
    fireEvent.input(await screen.findByLabelText("Code"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm identity/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Email me a code/ }));
    fireEvent.input(await screen.findByRole("textbox"), { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));
    const checking = await screen.findByRole("button", { name: "Checking…" });
    expect(checking.getAttribute("aria-busy")).toBe("true");
    expect((checking as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(checking);
    await Promise.resolve();
    expect(account.changeEmailComplete).toHaveBeenCalledTimes(1);
  });

  it("reads a refused code under the code field, tied to it", async () => {
    account.changeEmailBegin.mockResolvedValue({ sent: true });
    account.changeEmailComplete.mockRejectedValue(apiError("PLANTED-complete"));
    stepUp.otpBegin.mockResolvedValue({ sent: true });
    stepUp.otpComplete.mockResolvedValue({ token: "eyJsu", expiresIn: 300 });
    mount();

    fireEvent.input(screen.getByLabelText("New email"), { target: { value: "next@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send verification code/ }));
    const codeInput = await screen.findByLabelText("Code");
    fireEvent.input(codeInput, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /Confirm identity/ }));
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/ }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/ }));
    const stepUpInput = await screen.findByRole("textbox");
    fireEvent.input(stepUpInput, { target: { value: "654321" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(CODE);
    expect(alertsText()).not.toContain("PLANTED");
    const field = screen.getByLabelText("Code");
    expect(field.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(field.getAttribute("aria-invalid")).toBe("true");
  });
});
