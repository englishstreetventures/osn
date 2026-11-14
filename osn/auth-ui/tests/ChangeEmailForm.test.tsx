// @vitest-environment happy-dom
import type { AccountClient, StepUpClient } from "@osn/client";
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { ChangeEmailForm } from "../src/ChangeEmailForm";
import { DETAILS, WAIT, alertsText, apiError } from "./helpers/errors";
import { withoutAnimations } from "./helpers/motion";

// The step-up sheet closes at once, as under reduced motion, and hands its
// outcome over then (`helpers/motion.ts`).
withoutAnimations();

interface AccountStub {
  changeEmailBegin: ReturnType<typeof vi.fn>;
  changeEmailStatus: ReturnType<typeof vi.fn>;
  changeEmailResend: ReturnType<typeof vi.fn>;
  changeEmailComplete: ReturnType<typeof vi.fn>;
}
interface StepUpStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  emailBegin: ReturnType<typeof vi.fn>;
  emailStatus: ReturnType<typeof vi.fn>;
  emailResend: ReturnType<typeof vi.fn>;
}

const CHANGE_REQUEST = {
  requestId: "emailchange_0123456789ab",
  claimSecret: "a".repeat(64),
  pairingCode: "42",
  expiresAt: 1_900_000_000,
};
const STEP_UP_REQUEST = {
  requestId: "stepup_0123456789ab",
  claimSecret: "b".repeat(64),
  pairingCode: "47",
  expiresAt: 1_900_000_000,
};

describe("ChangeEmailForm", () => {
  let account: AccountStub;
  let stepUp: StepUpStub;

  beforeEach(() => {
    account = {
      changeEmailBegin: vi.fn(),
      changeEmailStatus: vi.fn(),
      changeEmailResend: vi.fn(),
      changeEmailComplete: vi.fn(),
    };
    stepUp = {
      passkeyBegin: vi.fn(),
      passkeyComplete: vi.fn(),
      emailBegin: vi.fn(),
      emailStatus: vi.fn(),
      emailResend: vi.fn(),
    };
  });

  afterEach(() => cleanup());

  function mount(onChanged?: (email: string) => void) {
    render(() => (
      <ChangeEmailForm
        accountClient={account as unknown as AccountClient}
        stepUpClient={stepUp as unknown as StepUpClient}
        onChanged={onChanged}
      />
    ));
  }

  /** From the address field to the step-up: the link sent, then confirmed elsewhere. */
  async function toStepUp() {
    account.changeEmailBegin.mockResolvedValue(CHANGE_REQUEST);
    account.changeEmailStatus.mockResolvedValue({ status: "confirmed" });
    stepUp.emailBegin.mockResolvedValue(STEP_UP_REQUEST);
    stepUp.emailStatus.mockResolvedValue({
      status: "complete",
      token: { token: "eyJsu", expiresIn: 300 },
    });
    fireEvent.input(screen.getByLabelText("New email"), { target: { value: "next@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send a link/ }));
    await screen.findByRole("heading", { name: "Check your email" });
    expect(screen.getByText("42")).toBeTruthy();
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(await screen.findByRole("button", { name: /Email me a link/ }));
    await screen.findByText("47");
    window.dispatchEvent(new Event("focus"));
  }

  it("runs the full begin → confirmed link → step-up → complete happy path", async () => {
    account.changeEmailComplete.mockResolvedValue({ email: "next@example.com" });
    const onChanged = vi.fn();
    mount(onChanged);
    await toStepUp();

    await waitFor(() =>
      expect(account.changeEmailComplete).toHaveBeenCalledWith({
        requestId: CHANGE_REQUEST.requestId,
        claimSecret: CHANGE_REQUEST.claimSecret,
        stepUpToken: "eyJsu",
      }),
    );
    expect(account.changeEmailBegin).toHaveBeenCalledWith({ newEmail: "next@example.com" });
    expect(stepUp.emailBegin).toHaveBeenCalledWith({ purpose: "email_change" });
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith("next@example.com"));
  });

  it.each([
    ["a refusal", apiError("PLANTED-begin"), DETAILS, "true"],
    ["a 429", apiError("PLANTED-begin-429", 429, "rate_limited"), WAIT, null],
  ])(
    "reads %s to send the link under the email field, tied to it",
    async (_, error, sentence, invalid) => {
      account.changeEmailBegin.mockRejectedValue(error);
      mount();
      const emailInput = screen.getByLabelText("New email");
      fireEvent.input(emailInput, { target: { value: "next@example.com" } });
      fireEvent.click(screen.getByRole("button", { name: /Send a link/ }));

      const alert = await screen.findByRole("alert");
      expect(alert.textContent).toContain(sentence);
      expect(alertsText()).not.toContain("PLANTED");
      expect(emailInput.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
      expect(emailInput.getAttribute("aria-invalid")).toBe(invalid);
      expect(alert.closest("label")).toBeNull();
    },
  );

  // The button holds focus through its wait: `busy`, not `disabled`.
  it("keeps Send a link busy, not disabled, while it sends", async () => {
    account.changeEmailBegin.mockReturnValue(new Promise(() => {}));
    mount();
    fireEvent.input(screen.getByLabelText("New email"), { target: { value: "next@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /Send a link/ }));
    const sending = await screen.findByRole("button", { name: "Sending…" });
    expect(sending.getAttribute("aria-busy")).toBe("true");
    expect((sending as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(sending);
    await Promise.resolve();
    expect(account.changeEmailBegin).toHaveBeenCalledTimes(1);
  });

  // A refused complete goes back to the wait with the map's sentence; the
  // poll then says whether the request can still be completed.
  it("reads a refused complete in the wait, without the server's text", async () => {
    account.changeEmailComplete.mockRejectedValue(
      apiError("PLANTED-complete-429", 429, "rate_limited"),
    );
    mount();
    await toStepUp();
    await waitFor(() => expect(account.changeEmailComplete).toHaveBeenCalledTimes(1));
    await screen.findByRole("heading", { name: "Check your email" });
    await waitFor(() => expect(document.body.textContent).toContain(WAIT));
    expect(document.body.textContent).not.toContain("PLANTED");
  });
});
