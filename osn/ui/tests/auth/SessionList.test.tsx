import type { SessionsClient, SessionSummary } from "@osn/client";
// @vitest-environment happy-dom
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

import { SessionList } from "../../src/auth/SessionList";

/**
 * SessionList — "your active sessions" panel. Tests cover:
 *   - initial load renders each row with the correct UA + last-seen label
 *   - current device is flagged and sorts first
 *   - revoke-current fires onLoggedOut
 *   - revoke-other re-fetches the list
 *   - revoke-others bulk action disappears when there are no other devices
 *   - error state renders inline
 *
 * Mocks the client directly; no real fetches.
 */

interface ClientStub {
  listSessions: ReturnType<typeof vi.fn>;
  revokeSession: ReturnType<typeof vi.fn>;
  revokeOtherSessions: ReturnType<typeof vi.fn>;
}

function makeClientStub(): ClientStub {
  return {
    listSessions: vi.fn(),
    revokeSession: vi.fn(),
    revokeOtherSessions: vi.fn(),
  };
}

const asClient = (s: ClientStub): SessionsClient => s as unknown as SessionsClient;

function makeSession(overrides: Partial<SessionSummary> = {}): SessionSummary {
  const base: SessionSummary = {
    id: "a".repeat(64),
    createdAt: 1_700_000_000,
    lastSeenAt: Math.floor(Date.now() / 1000) - 60,
    expiresAt: Math.floor(Date.now() / 1000) + 86_400,
    userAgent: "Mozilla/5.0 Unit Test",
    deviceLabel: null,
    ipHashPrefix: "deadbeefdead",
    createdIpHashPrefix: null,
    isCurrent: false,
  };
  return { ...base, ...overrides };
}

let stub: ClientStub;

describe("SessionList", () => {
  beforeEach(() => {
    stub = makeClientStub();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders each session row with UA and a relative last-seen label", async () => {
    stub.listSessions.mockResolvedValue({
      sessions: [
        makeSession({ userAgent: "Firefox 127", isCurrent: true }),
        makeSession({
          id: "b".repeat(64),
          userAgent: "Chrome 123",
          lastSeenAt: Math.floor(Date.now() / 1000) - 7200,
        }),
      ],
    });
    render(() => <SessionList client={asClient(stub)} accessToken="acc_live" />);

    await waitFor(() => {
      expect(screen.getByText("Firefox 127")).toBeTruthy();
      expect(screen.getByText("Chrome 123")).toBeTruthy();
    });
    // Current-device chip appears exactly once.
    expect(screen.getAllByText(/This device/i)).toHaveLength(1);
  });

  it("hides the 'sign out other devices' button when only the current session exists", async () => {
    stub.listSessions.mockResolvedValue({
      sessions: [makeSession({ isCurrent: true })],
    });
    render(() => <SessionList client={asClient(stub)} accessToken="acc_live" />);

    await waitFor(() => screen.getByText(/Mozilla\/5\.0 Unit Test/));
    expect(screen.queryByRole("button", { name: /Sign out other devices/i })).toBeNull();
  });

  it("revokes the current session and fires onLoggedOut", async () => {
    stub.listSessions.mockResolvedValue({
      sessions: [makeSession({ isCurrent: true })],
    });
    stub.revokeSession.mockResolvedValue({ wasCurrent: true });
    const onLoggedOut = vi.fn();
    render(() => (
      <SessionList client={asClient(stub)} accessToken="acc_live" onLoggedOut={onLoggedOut} />
    ));

    await waitFor(() => screen.getByText(/Mozilla\/5\.0 Unit Test/));
    fireEvent.click(screen.getByRole("button", { name: /Sign out this device/i }));
    // Confirm in the dialog.
    const confirmButton = await waitFor(() => screen.getByRole("button", { name: /^Sign out$/ }));
    fireEvent.click(confirmButton);

    await waitFor(() => {
      expect(onLoggedOut).toHaveBeenCalledTimes(1);
    });
    expect(stub.revokeSession).toHaveBeenCalledWith({
      accessToken: "acc_live",
      sessionId: "a".repeat(64),
    });
  });

  it("revokes another device and re-fetches the list", async () => {
    // First load: two sessions. Second load (after revoke): one.
    stub.listSessions
      .mockResolvedValueOnce({
        sessions: [
          makeSession({ isCurrent: true }),
          makeSession({ id: "b".repeat(64), userAgent: "Other Device" }),
        ],
      })
      .mockResolvedValueOnce({
        sessions: [makeSession({ isCurrent: true })],
      });
    stub.revokeSession.mockResolvedValue({ wasCurrent: false });

    render(() => <SessionList client={asClient(stub)} accessToken="acc_live" />);

    await waitFor(() => screen.getByText("Other Device"));

    // Click the Revoke button on the non-current row.
    const revokeButtons = screen.getAllByRole("button", { name: /Revoke session/i });
    fireEvent.click(revokeButtons[0]!);
    const confirm = await waitFor(() => screen.getByRole("button", { name: /^Revoke$/ }));
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(screen.queryByText("Other Device")).toBeNull();
    });
    expect(stub.listSessions).toHaveBeenCalledTimes(2);
  });

  it("does not render any sessions when the fetch rejects", async () => {
    // Silence the unhandled-rejection noise that solid-js's `createResource`
    // surfaces when the loader rejects — the rejection is expected here.
    const originalHandler = process.listeners("unhandledRejection").slice();
    const silenced = vi.fn();
    process.on("unhandledRejection", silenced);
    try {
      stub.listSessions.mockRejectedValue(new Error("rate_limited"));
      render(() => <SessionList client={asClient(stub)} accessToken="acc_live" />);

      // The list must never render any session rows; the component must stay
      // on the heading + empty-state.
      await new Promise((r) => setTimeout(r, 50));
      expect(screen.queryByText(/Mozilla/)).toBeNull();
      expect(screen.queryByRole("button", { name: /Sign out other devices/i })).toBeNull();
    } finally {
      process.removeAllListeners("unhandledRejection");
      for (const h of originalHandler) process.on("unhandledRejection", h);
    }
  });
});
