// @vitest-environment happy-dom
import type { AccountExportClient, StepUpClient, StepUpToken } from "@osn/client";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DataExportView } from "../../src/auth/DataExportView";

/**
 * T-S2 — coverage for the shared `<DataExportView />` Solid component
 * consumed by both `@osn/social` and `@pulse/app`. Pins:
 *   • The cooldown countdown disables the action button when the
 *     status endpoint reports a future `nextAvailableAt`.
 *   • Errors render with a destructive class.
 *   • Status-fetch failures fail quiet (do not block the UI).
 *   • The step-up → download → done phase machine wires up correctly,
 *     including the custom `onDownload` injection point that Tauri
 *     builds use to write through the system save dialog.
 */

interface AccountExportStub {
  status: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
}
interface StepUpStub {
  passkeyBegin: ReturnType<typeof vi.fn>;
  passkeyComplete: ReturnType<typeof vi.fn>;
  otpBegin: ReturnType<typeof vi.fn>;
  otpComplete: ReturnType<typeof vi.fn>;
}

const makeAccountExport = (): AccountExportStub => ({
  status: vi.fn(),
  download: vi.fn(),
});
const makeStepUp = (): StepUpStub => ({
  passkeyBegin: vi.fn(),
  passkeyComplete: vi.fn(),
  otpBegin: vi.fn(),
  otpComplete: vi.fn(),
});

const asAccountExport = (s: AccountExportStub): AccountExportClient =>
  s as unknown as AccountExportClient;
const asStepUp = (s: StepUpStub): StepUpClient => s as unknown as StepUpClient;

const stepUpToken: StepUpToken = { token: "stpup_xxx", expiresIn: 300 };

let ae: AccountExportStub;
let su: StepUpStub;

describe("DataExportView", () => {
  beforeEach(() => {
    ae = makeAccountExport();
    su = makeStepUp();
  });
  afterEach(() => cleanup());

  it("renders the action button enabled when no cooldown is active", async () => {
    ae.status.mockResolvedValue({ lastExportAt: null, nextAvailableAt: null });
    render(() => (
      <DataExportView
        accountExportClient={asAccountExport(ae)}
        stepUpClient={asStepUp(su)}
        accessToken="acc"
      />
    ));
    const btn = await waitFor(() => screen.getByRole("button", { name: /Download my data/ }));
    expect(btn.hasAttribute("disabled")).toBe(false);
  });

  it("disables the button + shows a countdown label while in cooldown", async () => {
    const next = new Date(Date.now() + 12 * 3_600_000).toISOString();
    ae.status.mockResolvedValue({
      lastExportAt: new Date().toISOString(),
      nextAvailableAt: next,
    });
    render(() => (
      <DataExportView
        accountExportClient={asAccountExport(ae)}
        stepUpClient={asStepUp(su)}
        accessToken="acc"
      />
    ));
    await waitFor(() => screen.getByText(/Available again/));
    const btn = screen.getByRole("button", { name: /Download my data/ }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("treats a status-fetch failure as informational (button stays enabled)", async () => {
    ae.status.mockRejectedValue(new Error("network"));
    render(() => (
      <DataExportView
        accountExportClient={asAccountExport(ae)}
        stepUpClient={asStepUp(su)}
        accessToken="acc"
      />
    ));
    const btn = (await waitFor(() =>
      screen.getByRole("button", { name: /Download my data/ }),
    )) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
  });

  it("step-up → download → done: full happy path with onDownload override", async () => {
    ae.status.mockResolvedValue({ lastExportAt: null, nextAvailableAt: null });
    // Build a tiny streaming Response that yields one chunk + ends.
    const ndjsonChunks = [
      new TextEncoder().encode('{"version":1,"sections":[]}\n'),
      new TextEncoder().encode('{"end":true}\n'),
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of ndjsonChunks) controller.enqueue(c);
        controller.close();
      },
    });
    ae.download.mockResolvedValue(new Response(body));
    su.otpBegin.mockResolvedValue({ sent: true });
    su.otpComplete.mockResolvedValue(stepUpToken);

    const onDownload = vi.fn().mockResolvedValue(undefined);
    render(() => (
      <DataExportView
        accountExportClient={asAccountExport(ae)}
        stepUpClient={asStepUp(su)}
        accessToken="acc"
        onDownload={onDownload}
      />
    ));

    await waitFor(() => screen.getByRole("button", { name: /Download my data/ }));
    fireEvent.click(screen.getByRole("button", { name: /Download my data/ })!);

    // Step-up dialog appears with a "Use passkey" / "Email me a code" pair.
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/ }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/ })!);

    // Code input appears; type 6 digits then confirm.
    const input = await waitFor(() => screen.getByDisplayValue("") as HTMLInputElement);
    fireEvent.input(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ })!);

    // Wait for the download to be triggered with the right token + the
    // injected onDownload to receive a Blob.
    await waitFor(() => expect(onDownload).toHaveBeenCalledTimes(1));
    expect(ae.download).toHaveBeenCalledWith({
      accessToken: "acc",
      stepUpToken: stepUpToken.token,
    });
    const [blob, filename] = onDownload.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect((blob as Blob).type).toBe("application/x-ndjson");
    expect(filename).toMatch(/^osn-data-export-\d{4}-\d{2}-\d{2}\.ndjson$/);

    // Final phase ("done") surfaces a confirmation message.
    await waitFor(() => screen.getByText(/Download started/));
  });

  it("renders the destructive error message when the download throws", async () => {
    ae.status.mockResolvedValue({ lastExportAt: null, nextAvailableAt: null });
    ae.download.mockRejectedValue(new Error("rate_limited"));
    su.otpBegin.mockResolvedValue({ sent: true });
    su.otpComplete.mockResolvedValue(stepUpToken);

    render(() => (
      <DataExportView
        accountExportClient={asAccountExport(ae)}
        stepUpClient={asStepUp(su)}
        accessToken="acc"
      />
    ));

    await waitFor(() => screen.getByRole("button", { name: /Download my data/ }));
    fireEvent.click(screen.getByRole("button", { name: /Download my data/ })!);
    await waitFor(() => screen.getByRole("button", { name: /Email me a code/ }));
    fireEvent.click(screen.getByRole("button", { name: /Email me a code/ })!);
    const input = await waitFor(() => screen.getByDisplayValue("") as HTMLInputElement);
    fireEvent.input(input, { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: /^Confirm$/ })!);

    const errEl = await waitFor(() => screen.getByText(/rate_limited/));
    expect(errEl).toBeTruthy();
    // The success-state confirmation text must NOT appear when the
    // download throws.
    expect(screen.queryByText(/Download started/)).toBeNull();
  });

  it("step-up cancel resets to idle without firing a download", async () => {
    ae.status.mockResolvedValue({ lastExportAt: null, nextAvailableAt: null });
    render(() => (
      <DataExportView
        accountExportClient={asAccountExport(ae)}
        stepUpClient={asStepUp(su)}
        accessToken="acc"
      />
    ));
    await waitFor(() => screen.getByRole("button", { name: /Download my data/ }));
    fireEvent.click(screen.getByRole("button", { name: /Download my data/ })!);
    await waitFor(() => screen.getByRole("button", { name: /^Cancel$/ }));
    fireEvent.click(screen.getByRole("button", { name: /^Cancel$/ })!);
    // Back to idle.
    await waitFor(() => screen.getByRole("button", { name: /Download my data/ }));
    expect(ae.download).not.toHaveBeenCalled();
  });
});
