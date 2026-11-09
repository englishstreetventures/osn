// @vitest-environment happy-dom
import type { SessionsClient } from "@osn/client";
import { render, cleanup, screen, fireEvent, waitFor } from "@solidjs/testing-library";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { SessionsView } from "../src/SessionsView";
import { SERVER, WAIT, alertsText, apiError } from "./helpers/errors";

/**
 * Settings → Sessions view. Tests cover:
 *   - renders all sessions with coarse UA labels
 *   - "this device" badge appears on the current session
 *   - Revoke button is disabled for the current session
 *   - Revoke non-current session triggers client.revoke + refetches
 *   - "Sign out everywhere else" calls revokeAllOther
 */

interface ClientStub {
  list: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
  revokeAllOther: ReturnType<typeof vi.fn>;
}

function makeStub(): ClientStub {
  return {
    list: vi.fn(),
    revoke: vi.fn(),
    revokeAllOther: vi.fn(),
  };
}

const asClient = (s: ClientStub): SessionsClient => s as unknown as SessionsClient;

const sessions = [
  {
    id: "cafebabe12345678",
    uaLabel: "Firefox on macOS",
    createdAt: 1,
    lastUsedAt: 2,
    expiresAt: 3,
    isCurrent: true,
  },
  {
    id: "deadbeef87654321",
    uaLabel: "Safari on iOS",
    createdAt: 4,
    lastUsedAt: 5,
    expiresAt: 6,
    isCurrent: false,
  },
];

let stub: ClientStub;

describe("SessionsView", () => {
  // Prevent jsdom from blocking on confirm() dialogs.
  beforeEach(() => {
    stub = makeStub();
    window.confirm = () => true;
  });

  afterEach(() => cleanup());

  it("renders all sessions with UA labels and marks the current one", async () => {
    stub.list.mockResolvedValue({ sessions });
    render(() => <SessionsView client={asClient(stub)} />);

    await waitFor(() => {
      expect(screen.getByText(/Firefox on macOS/)).toBeTruthy();
      expect(screen.getByText(/Safari on iOS/)).toBeTruthy();
      expect(screen.getByText(/this device/)).toBeTruthy();
    });
  });

  it("disables revoke for the current session but allows revoking others", async () => {
    stub.list.mockResolvedValueOnce({ sessions });
    stub.list.mockResolvedValueOnce({ sessions: [sessions[0]] });
    stub.revoke.mockResolvedValue({ revokedSelf: false });
    render(() => <SessionsView client={asClient(stub)} />);

    await waitFor(() => screen.getAllByRole("button", { name: /^Revoke$/ }));
    const buttons = screen.getAllByRole("button", { name: /^Revoke$/ }) as HTMLButtonElement[];
    // The first session is current — its button is disabled.
    expect(buttons[0]!.disabled).toBe(true);
    // The second is not current — clicking revokes it.
    fireEvent.click(buttons[1]!);
    await waitFor(() =>
      expect(stub.revoke).toHaveBeenCalledWith({
        id: "deadbeef87654321",
      }),
    );
  });

  it('"Sign out everywhere else" calls revokeAllOther', async () => {
    stub.list.mockResolvedValueOnce({ sessions });
    stub.list.mockResolvedValueOnce({ sessions: [sessions[0]] });
    stub.revokeAllOther.mockResolvedValue({ success: true });
    render(() => <SessionsView client={asClient(stub)} />);

    await waitFor(() => screen.getByRole("button", { name: /Sign out everywhere else/ }));
    fireEvent.click(screen.getByRole("button", { name: /Sign out everywhere else/ }));
    await waitFor(() => expect(stub.revokeAllOther).toHaveBeenCalledTimes(1));
  });

  it.each([
    ["revoke", apiError("PLANTED-revoke", 503, "temporarily_unavailable"), SERVER],
    ["sign out everywhere else", apiError("PLANTED-revoke-all", 429, "rate_limited"), WAIT],
  ])("reads a failed %s as the map's sentence, never its text", async (action, error, sentence) => {
    stub.list.mockResolvedValue({ sessions });
    stub.revoke.mockRejectedValue(error);
    stub.revokeAllOther.mockRejectedValue(error);
    render(() => <SessionsView client={asClient(stub)} />);

    await waitFor(() => screen.getAllByRole("button", { name: /^Revoke$/ }));
    if (action === "revoke") {
      fireEvent.click(screen.getAllByRole("button", { name: /^Revoke$/ })[1]!);
    } else {
      fireEvent.click(screen.getByRole("button", { name: /Sign out everywhere else/ }));
    }
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(sentence);
    expect(alertsText()).not.toContain("PLANTED");
  });

  it("says a list that failed to load didn't, with a Try again that reloads it", async () => {
    stub.list
      .mockRejectedValueOnce(apiError("PLANTED-list", 500, "internal_error"))
      .mockResolvedValueOnce({ sessions });
    render(() => <SessionsView client={asClient(stub)} />);

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Your sessions didn't load.");
    expect(alertsText()).not.toContain("PLANTED");
    expect(screen.getByRole("heading", { name: "Active sessions" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => screen.getByText(/Firefox on macOS/));
    expect(stub.list).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
