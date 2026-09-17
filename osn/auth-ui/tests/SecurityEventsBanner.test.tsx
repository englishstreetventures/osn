// @vitest-environment happy-dom
import type { SecurityEventsClient, SecurityEventSummary, StepUpClient } from "@osn/client";
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { SecurityEventsBanner } from "../src/SecurityEventsBanner";

/**
 * Settings banner for out-of-band security events (M-PK1b). Tests cover:
 *   - empty list renders nothing (banner collapses entirely)
 *   - recovery_code_generate event renders headline + timestamp + UA label
 *   - recovery_code_consume event renders the takeover-specific headline
 *   - unknown kinds fall through to a generic message (forward-compat)
 *   - "Acknowledge" opens the step-up dialog, NOT the ack endpoint directly (S-M1)
 *   - a successful step-up ceremony calls acknowledgeAll and optimistically removes the events
 *   - a rejected acknowledgeAll surfaces the error text in the banner
 */

interface ClientStub {
  list: ReturnType<typeof vi.fn>;
  acknowledge: ReturnType<typeof vi.fn>;
  acknowledgeAll: ReturnType<typeof vi.fn>;
}

interface StepUpStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
}

function makeClientStub(): ClientStub {
  return {
    list: vi.fn(),
    acknowledge: vi.fn(),
    acknowledgeAll: vi.fn(),
  };
}

function makeStepUpStub(): StepUpStub {
  return {
    passkeyBegin: vi.fn(),
    passkeyComplete: vi.fn(),
    otpBegin: vi.fn().mockResolvedValue({ sent: true }),
    otpComplete: vi.fn().mockResolvedValue({ token: "eyJ.step.up", expiresIn: 300 }),
  };
}

const asClient = (s: ClientStub): SecurityEventsClient => s as unknown as SecurityEventsClient;
const asStepUp = (s: StepUpStub): StepUpClient => s as unknown as StepUpClient;

const recoveryGenerateEvent: SecurityEventSummary = {
  id: "sev_abcdef012345",
  kind: "recovery_code_generate",
  createdAt: 1_700_000_000,
  uaLabel: "Firefox on macOS",
  ipHash: "deadbeef",
};

const recoveryConsumeEvent: SecurityEventSummary = {
  id: "sev_ffffff000000",
  kind: "recovery_code_consume",
  createdAt: 1_700_000_500,
  uaLabel: "Safari on iOS",
  ipHash: "cafebabe",
};

let stub: ClientStub;
let stepUp: StepUpStub;

describe("SecurityEventsBanner", () => {
  beforeEach(() => {
    stub = makeClientStub();
    stepUp = makeStepUpStub();
  });

  afterEach(() => cleanup());

  it("renders nothing when the list is empty", async () => {
    stub.list.mockResolvedValue({ events: [] });
    const { container } = render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
      />
    ));
    await waitFor(() => expect(stub.list).toHaveBeenCalledTimes(1));
    expect(container.textContent?.trim()).toBe("");
  });

  it("renders the recovery_code_generate headline with UA label", async () => {
    stub.list.mockResolvedValue({ events: [recoveryGenerateEvent] });
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
      />
    ));
    await waitFor(() => {
      expect(screen.getByText(/your Musubi recovery codes were regenerated/i)).toBeTruthy();
      expect(screen.getByText(/Firefox on macOS/)).toBeTruthy();
    });
  });

  // S-H1: the takeover half of the threat model — gets its own headline so
  // the user knows the codes were USED, not just regenerated.
  it("renders the recovery_code_consume headline", async () => {
    stub.list.mockResolvedValue({ events: [recoveryConsumeEvent] });
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
      />
    ));
    await waitFor(() => {
      expect(screen.getByText(/a recovery code was used on your Musubi account/i)).toBeTruthy();
    });
  });

  it("falls back to a generic headline for unknown kinds (forward-compat)", async () => {
    const futureEvent = {
      ...recoveryGenerateEvent,
      id: "sev_future0000",
      kind: "passkey_registered" as unknown as SecurityEventSummary["kind"],
    };
    stub.list.mockResolvedValue({ events: [futureEvent] });
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
      />
    ));
    await waitFor(() => {
      expect(screen.getByText(/Security event on your account/i)).toBeTruthy();
    });
  });

  // S-M1: clicking "Acknowledge" must NOT hit the ack endpoint with the raw
  // access token — it opens the step-up dialog instead.
  it("'Acknowledge' opens the step-up dialog; ack-all is only called after a token is minted", async () => {
    stub.list.mockResolvedValue({ events: [recoveryGenerateEvent, recoveryConsumeEvent] });
    stub.acknowledgeAll.mockResolvedValue({ acknowledged: 2 });
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
      />
    ));
    await waitFor(() => screen.getByRole("button", { name: /Acknowledge/ }));

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));

    // The step-up dialog is open; the ack endpoint has NOT been called yet.
    expect(stub.acknowledgeAll).not.toHaveBeenCalled();

    // Drive the OTP flow in the step-up dialog.
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));
    await waitFor(() => expect(stepUp.otpBegin).toHaveBeenCalled());
    fireEvent.input(screen.getByLabelText(/Code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() =>
      expect(stub.acknowledgeAll).toHaveBeenCalledWith({
        accessToken: "acc",
        stepUpToken: "eyJ.step.up",
      }),
    );
    // P-I3: list NOT re-fetched — the banner removed events optimistically.
    expect(stub.list).toHaveBeenCalledTimes(1);
    // Banner collapses.
    await waitFor(() => {
      expect(screen.queryByText(/recovery codes were regenerated/i)).toBeNull();
    });
  });

  it("surfaces an error message when acknowledgeAll rejects", async () => {
    stub.list.mockResolvedValue({ events: [recoveryGenerateEvent] });
    stub.acknowledgeAll.mockRejectedValue(new Error("server on fire"));
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
      />
    ));
    await waitFor(() => screen.getByRole("button", { name: /Acknowledge/ }));
    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));
    await waitFor(() => expect(stepUp.otpBegin).toHaveBeenCalled());
    fireEvent.input(screen.getByLabelText(/Code/i), {
      target: { value: "123456" },
    });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() => {
      expect(screen.getByText(/server on fire/)).toBeTruthy();
    });
  });

  // A host may mount this in an application shell rather than a settings
  // panel. There a thrown resource blanks every route, and a host stacking its
  // own banners under this one needs to know whether this one is showing.

  it("renders nothing, rather than throwing, when the list cannot be read", async () => {
    stub.list.mockRejectedValue(new Error("Request failed: 429"));
    const { container } = render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
      />
    ));
    await waitFor(() => expect(stub.list).toHaveBeenCalledTimes(1));
    expect(container.textContent?.trim()).toBe("");
  });

  it("reports its count only once the read has settled", async () => {
    const counts: number[] = [];
    let resolveList: (value: { events: SecurityEventSummary[] }) => void = () => {};
    stub.list.mockReturnValue(
      new Promise<{ events: SecurityEventSummary[] }>((resolve) => {
        resolveList = resolve;
      }),
    );
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
        onVisibleCountChange={(count) => counts.push(count)}
      />
    ));

    // Silence while the request is in flight is the point: a host told "0"
    // here would show its own banner and then have to pull it away.
    expect(counts).toEqual([]);

    resolveList({ events: [recoveryGenerateEvent] });
    await waitFor(() => expect(counts).toEqual([1]));
  });

  it("reports zero for an empty list", async () => {
    const counts: number[] = [];
    stub.list.mockResolvedValue({ events: [] });
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
        onVisibleCountChange={(count) => counts.push(count)}
      />
    ));
    await waitFor(() => expect(counts).toEqual([0]));
  });

  it("reports zero for a list it could not read", async () => {
    const counts: number[] = [];
    stub.list.mockRejectedValue(new Error("Request failed: 429"));
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
        onVisibleCountChange={(count) => counts.push(count)}
      />
    ));
    await waitFor(() => expect(counts).toEqual([0]));
  });

  it("reports zero again once the events are acknowledged", async () => {
    const counts: number[] = [];
    stub.list.mockResolvedValue({ events: [recoveryGenerateEvent] });
    stub.acknowledgeAll.mockResolvedValue({ acknowledged: 1 });
    render(() => (
      <SecurityEventsBanner
        client={asClient(stub)}
        stepUpClient={asStepUp(stepUp)}
        accessToken="acc"
        productName="Musubi"
        onVisibleCountChange={(count) => counts.push(count)}
      />
    ));
    await waitFor(() => expect(counts).toEqual([1]));

    fireEvent.click(screen.getByRole("button", { name: /Acknowledge/ }));
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/i }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/i }));
    await waitFor(() => expect(stepUp.otpBegin).toHaveBeenCalled());
    fireEvent.input(screen.getByLabelText(/Code/i), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ }));

    await waitFor(() => expect(counts).toEqual([1, 0]));
  });
});
