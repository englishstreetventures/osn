import type { RecoveryClient } from "@osn/client";
// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { RecoveryCodesView } from "../../src/auth/RecoveryCodesView";

/**
 * Show-once recovery-code view. Tests cover:
 *  - generate → codes render → acknowledge → view clears + onSaved fires
 *  - Done button is gated on the "I've saved" checkbox
 *  - generate failures surface an inline error without rendering any codes
 *  - the component never re-renders codes once dismissed (the caller has to
 *    explicitly re-generate)
 */

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

describe("RecoveryCodesView", () => {
  beforeEach(() => {
    stub = makeClientStub();
  });

  afterEach(() => {
    cleanup();
  });

  it("generates codes on click and renders all 10", async () => {
    stub.generateRecoveryCodes.mockResolvedValue({ codes: sampleCodes });
    render(() => <RecoveryCodesView client={asClient(stub)} accessToken="acc_live" />);

    fireEvent.click(screen.getByRole("button", { name: /Generate recovery codes/i }));
    await waitFor(() => {
      for (const code of sampleCodes) {
        expect(screen.getByText(code)).toBeTruthy();
      }
    });

    expect(stub.generateRecoveryCodes).toHaveBeenCalledWith({ accessToken: "acc_live" });
  });

  it("Done button is disabled until the 'I've saved' checkbox is ticked", async () => {
    stub.generateRecoveryCodes.mockResolvedValue({ codes: sampleCodes });
    render(() => <RecoveryCodesView client={asClient(stub)} accessToken="acc_live" />);

    fireEvent.click(screen.getByRole("button", { name: /Generate recovery codes/i }));
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
    render(() => (
      <RecoveryCodesView client={asClient(stub)} accessToken="acc_live" onSaved={onSaved} />
    ));

    fireEvent.click(screen.getByRole("button", { name: /Generate recovery codes/i }));
    await waitFor(() => screen.getByText(sampleCodes[0]!));

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: /^Done$/ }));

    // Codes no longer rendered — the view returns to the pre-generate state.
    await waitFor(() => {
      expect(screen.queryByText(sampleCodes[0]!)).toBeNull();
    });
    expect(screen.getByRole("button", { name: /Generate recovery codes/i })).toBeTruthy();
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it("shows an error message when generate throws and does not render any codes", async () => {
    stub.generateRecoveryCodes.mockRejectedValue(new Error("rate_limited"));
    render(() => <RecoveryCodesView client={asClient(stub)} accessToken="acc_live" />);

    fireEvent.click(screen.getByRole("button", { name: /Generate recovery codes/i }));
    await waitFor(() => {
      expect(screen.getByText(/rate_limited/)).toBeTruthy();
    });
    // None of the stale-set sample codes ever rendered.
    expect(screen.queryByText(sampleCodes[0]!)).toBeNull();
  });

  it("falls back to a generic error message when the thrown value has no message", async () => {
    stub.generateRecoveryCodes.mockRejectedValue("network");
    render(() => <RecoveryCodesView client={asClient(stub)} accessToken="acc_live" />);

    fireEvent.click(screen.getByRole("button", { name: /Generate recovery codes/i }));
    await waitFor(() => {
      expect(screen.getByText(/Failed to generate recovery codes/i)).toBeTruthy();
    });
  });
});
