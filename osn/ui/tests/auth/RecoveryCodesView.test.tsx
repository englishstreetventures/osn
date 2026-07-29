import type { RecoveryClient, StepUpClient } from "@osn/client";
// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { RecoveryCodesView } from "../../src/auth/RecoveryCodesView";

/**
 * Show-once recovery-code view. Tests cover:
 *  - status drives the pre-generate copy (no codes → warning; a set → counts)
 *  - generate runs the step-up ceremony first and forwards the minted token
 *  - codes render → acknowledge → view clears + onSaved fires
 *  - Done button is gated on the "I've saved" checkbox
 *  - generate failures surface an inline error without rendering any codes
 *  - a failed status read never blocks generation, but still warns before it
 *
 * happy-dom ships no `window.confirm`, so every test stubs it. The default
 * answer is "yes" — tests that care about the prompt override it.
 */

interface ClientStub {
  generateRecoveryCodes: ReturnType<typeof vi.fn>;
  getRecoveryCodesStatus: ReturnType<typeof vi.fn>;
  loginWithRecoveryCode: ReturnType<typeof vi.fn>;
}

interface StepUpStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
}

function makeClientStub(): ClientStub {
  return {
    generateRecoveryCodes: vi.fn(),
    getRecoveryCodesStatus: vi.fn().mockResolvedValue({ active: 0, total: 0, generatedAt: null }),
    loginWithRecoveryCode: vi.fn(),
  };
}

function makeStepUpStub(): StepUpStub {
  return {
    passkeyBegin: vi.fn().mockResolvedValue({ options: { challenge: "c" } }),
    passkeyComplete: vi
      .fn()
      .mockResolvedValue({ token: "su_tok", expiresAt: Math.floor(Date.now() / 1000) + 300 }),
    otpBegin: vi.fn(),
    otpComplete: vi.fn(),
  };
}

const asClient = (s: ClientStub): RecoveryClient => s as unknown as RecoveryClient;
const asStepUp = (s: StepUpStub): StepUpClient => s as unknown as StepUpClient;

const sampleCodes = [
  "abcd-1234-5678-ef00",
  "1111-2222-3333-4444",
  "dead-beef-cafe-0000",
  "aaaa-bbbb-cccc-dddd",
  "0000-1111-2222-3333",
  "4444-5555-6666-7777",
  "8888-9999-aaaa-bbbb",
  "cccc-dddd-eeee-ffff",
  "0123-4567-89ab-cdef",
  "fedc-ba98-7654-3210",
];

let stub: ClientStub;
let stepUp: StepUpStub;

/** Renders in passkey-only mode, so the dialog auto-runs the ceremony. */
function renderView(extra: Record<string, unknown> = {}) {
  return render(() => (
    <RecoveryCodesView
      client={asClient(stub)}
      stepUpClient={asStepUp(stepUp)}
      accessToken="acc_live"
      runPasskeyCeremony={async () => ({ id: "assertion" })}
      passkeyOnly
      {...extra}
    />
  ));
}

/**
 * Waits for the status read to settle — the button stays disabled until then —
 * and clicks it.
 */
async function clickGenerate(name: RegExp = /Generate recovery codes/i) {
  const button = await waitFor(() => {
    const b = screen.getByRole("button", { name }) as HTMLButtonElement;
    if (b.disabled) throw new Error("still loading");
    return b;
  });
  fireEvent.click(button);
}

describe("RecoveryCodesView", () => {
  beforeEach(() => {
    stub = makeClientStub();
    stepUp = makeStepUpStub();
    vi.stubGlobal("confirm", vi.fn().mockReturnValue(true));
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("warns when the account has no recovery codes", async () => {
    renderView();
    await waitFor(() => {
      expect(screen.getByText(/don't have any recovery codes yet/i)).toBeTruthy();
    });
  });

  it("shows the remaining count and creation date when a set exists", async () => {
    stub.getRecoveryCodesStatus.mockResolvedValue({
      active: 7,
      total: 10,
      generatedAt: 1_750_000_000,
    });
    renderView();
    await waitFor(() => {
      expect(screen.getByText(/7 of 10 codes unused/i)).toBeTruthy();
    });
    // An existing set turns the call to action into an explicit rotation.
    expect(screen.getByRole("button", { name: /Generate new codes/i })).toBeTruthy();
  });

  it("runs the step-up ceremony and forwards the minted token", async () => {
    stub.generateRecoveryCodes.mockResolvedValue({ codes: sampleCodes });
    renderView();

    await clickGenerate();
    await waitFor(() => {
      for (const code of sampleCodes) {
        expect(screen.getByText(code)).toBeTruthy();
      }
    });

    expect(stepUp.passkeyBegin).toHaveBeenCalledWith({ accessToken: "acc_live" });
    expect(stub.generateRecoveryCodes).toHaveBeenCalledWith({
      accessToken: "acc_live",
      stepUpToken: "su_tok",
    });
  });

  it("asks for confirmation before rotating an existing set (cancel leaves it untouched)", async () => {
    stub.getRecoveryCodesStatus.mockResolvedValue({
      active: 10,
      total: 10,
      generatedAt: 1_750_000_000,
    });
    renderView();

    // Clicking the primary button opens a confirmation dialog rather than
    // starting the ceremony — the existing set must not be rotated yet.
    await clickGenerate(/Generate new codes/i);
    await waitFor(() => expect(screen.getByText(/Generate a new set\?/i)).toBeTruthy());
    expect(stepUp.passkeyBegin).not.toHaveBeenCalled();

    // Declining the dialog leaves the existing set untouched — the ceremony
    // never starts.
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ }));
    expect(stepUp.passkeyBegin).not.toHaveBeenCalled();
    expect(stub.generateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("proceeds with the ceremony once the rotation dialog is confirmed", async () => {
    stub.getRecoveryCodesStatus.mockResolvedValue({
      active: 10,
      total: 10,
      generatedAt: 1_750_000_000,
    });
    stub.generateRecoveryCodes.mockResolvedValue({ codes: sampleCodes });
    renderView();

    await clickGenerate(/Generate new codes/i);
    await waitFor(() => screen.getByRole("button", { name: /Generate new set/i }));
    fireEvent.click(screen.getByRole("button", { name: /Generate new set/i }));

    await waitFor(() => expect(screen.getByText(sampleCodes[0]!)).toBeTruthy());
    expect(stepUp.passkeyBegin).toHaveBeenCalled();
  });

  it("Done button is disabled until the 'I've saved' checkbox is ticked", async () => {
    stub.generateRecoveryCodes.mockResolvedValue({ codes: sampleCodes });
    renderView();

    await clickGenerate();
    await waitFor(() => screen.getByRole("button", { name: /^Done$/ }));

    const done = screen.getByRole("button", { name: /^Done$/ }) as HTMLButtonElement;
    expect(done.disabled).toBe(true);

    const checkbox = screen.getByRole("checkbox") as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(done.disabled).toBe(false);
  });

  it("clears the displayed codes and fires onSaved after acknowledge", async () => {
    stub.generateRecoveryCodes.mockResolvedValue({ codes: sampleCodes });
    const onSaved = vi.fn();
    renderView({ onSaved });

    await clickGenerate();
    await waitFor(() => screen.getByText(sampleCodes[0]!));

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Done$/ }));

    // Codes no longer rendered — the view returns to the pre-generate state.
    await waitFor(() => {
      expect(screen.queryByText(sampleCodes[0]!)).toBeNull();
    });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("shows an error message when generate throws and does not render any codes", async () => {
    stub.generateRecoveryCodes.mockRejectedValue(new Error("rate_limited"));
    renderView();

    await clickGenerate();
    await waitFor(() => {
      expect(screen.getByText(/rate_limited/)).toBeTruthy();
    });
    // None of the stale-set sample codes ever rendered.
    expect(screen.queryByText(sampleCodes[0]!)).toBeNull();
  });

  it("falls back to a generic error message when the thrown value has no message", async () => {
    stub.generateRecoveryCodes.mockRejectedValue("network");
    renderView();

    await clickGenerate();
    await waitFor(() => {
      expect(screen.getByText(/Failed to generate recovery codes/i)).toBeTruthy();
    });
  });

  it("still allows generating when the status read fails", async () => {
    stub.getRecoveryCodesStatus.mockRejectedValue(new Error("offline"));
    stub.generateRecoveryCodes.mockResolvedValue({ codes: sampleCodes });
    renderView();

    await waitFor(() => {
      expect(screen.getByText(/Couldn't check whether you have recovery codes/i)).toBeTruthy();
    });
    // An unreadable count is treated conservatively as "might have codes", so
    // the rotation dialog gates generation — confirm it to proceed.
    await clickGenerate();
    await waitFor(() => screen.getByRole("button", { name: /Generate new set/i }));
    fireEvent.click(screen.getByRole("button", { name: /Generate new set/i }));
    await waitFor(() => screen.getByText(sampleCodes[0]!));
  });

  // S-L1: an unreadable count is not proof there is nothing to lose. The
  // warning has to appear anyway, or a failed status read silently skips the
  // one prompt standing between the user and a destroyed set.
  it("still warns before rotating when the status read fails", async () => {
    stub.getRecoveryCodesStatus.mockRejectedValue(new Error("offline"));
    renderView();

    await waitFor(() => {
      expect(screen.getByText(/Couldn't check whether you have recovery codes/i)).toBeTruthy();
    });
    // An unreadable count is treated as "might have codes", so the confirmation
    // dialog must still gate the ceremony.
    await clickGenerate();
    await waitFor(() => expect(screen.getByText(/Generate a new set\?/i)).toBeTruthy());

    expect(stepUp.passkeyBegin).not.toHaveBeenCalled();
    expect(stub.generateRecoveryCodes).not.toHaveBeenCalled();
  });

  it("holds the generate button until the status read settles", async () => {
    let release: (v: {
      active: number;
      total: number;
      generatedAt: number | null;
    }) => void = () => {};
    stub.getRecoveryCodesStatus.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    renderView();

    const button = await waitFor(
      () => screen.getByRole("button", { name: /Generate recovery codes/i }) as HTMLButtonElement,
    );
    // Until the count lands the view can't tell a first set from a rotation.
    expect(button.disabled).toBe(true);

    release({ active: 0, total: 0, generatedAt: null });
    await waitFor(() => expect(button.disabled).toBe(false));
  });
});
