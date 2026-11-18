// @vitest-environment happy-dom
import { AuthExpiredError, GraphClientError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the graph client before importing the page under test so the
// page's `graphClient` reference picks up the mocked implementation.
const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  listPendingRequests: vi.fn(),
  listSentRequests: vi.fn(),
  listBlocks: vi.fn(),
  removeConnection: vi.fn(),
  acceptConnection: vi.fn(),
  rejectConnection: vi.fn(),
  unblockProfile: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  graphClient: mocks,
  orgClient: {},
  recommendationClient: {},
}));

import { ConnectionsPage } from "../../src/pages/ConnectionsPage";

function authedProvider() {
  // One object per render: the page cache keys on the session object, so a
  // fresh one gives each test a fresh cache.
  const session = {
    accessToken: "tkn",
    idToken: null,
    expiresAt: Date.now() + 60_000,
    scopes: [],
  };
  const authValue = {
    session: Object.assign(() => session, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: session,
      refetch: () => {},
      mutate: () => {},
    }),
    profiles: Object.assign(() => [], {
      state: "ready",
      loading: false,
      error: undefined,
      latest: null,
      refetch: () => {},
      mutate: () => {},
    }),
    activeProfileId: () => "usr_1",
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => Promise.reject(new Error("unused")),
    createProfile: () => Promise.reject(new Error("unused")),
    deleteProfile: () => Promise.resolve(),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required for this test
  return authValue as any;
}

async function renderConnectionsPage() {
  mocks.listConnections.mockResolvedValue({
    connections: [{ handle: "bob", displayName: "Bob Jones" }],
  });
  mocks.listPendingRequests.mockResolvedValue({ pending: [] });
  mocks.listSentRequests.mockResolvedValue({ sent: [] });
  mocks.listBlocks.mockResolvedValue({ blocks: [] });
  mocks.removeConnection.mockResolvedValue(undefined);

  const result = render(() => (
    <AuthContext.Provider value={authedProvider()}>
      <ConnectionsPage />
    </AuthContext.Provider>
  ));
  // Wait for the `listConnections` resource to resolve and the row to render.
  await screen.findByText("Bob Jones");
  return result;
}

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.clearAllMocks();
});

describe("<ConnectionsPage /> — remove friend confirmation", () => {
  it("opens a confirmation dialog and does not call the API when clicking Remove on a row", async () => {
    await renderConnectionsPage();
    expect(document.title).toBe("Connections · Musubi");

    // The row-level "Remove" button is the only one in the DOM before the
    // dialog opens (the confirm button lives inside the portaled dialog).
    const rowRemove = screen.getByText("Remove");
    fireEvent.click(rowRemove);

    // Dialog title contains the display name of the targeted friend.
    const title = await screen.findByText(/Remove Bob Jones as a friend\?/);
    expect(title).toBeDefined();

    // Helper copy present.
    expect(screen.getByText("You can always add them again later.")).toBeDefined();

    // Critically: no API call yet — the dialog is purely a confirmation step.
    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("cancelling the dialog closes it and still does not call the API", async () => {
    await renderConnectionsPage();

    fireEvent.click(screen.getByText("Remove"));
    await screen.findByText(/Remove Bob Jones as a friend\?/);

    fireEvent.click(screen.getByText("Cancel"));

    expect(mocks.removeConnection).not.toHaveBeenCalled();
  });

  it("confirming the dialog invokes graphClient.removeConnection exactly once with the correct handle", async () => {
    await renderConnectionsPage();

    fireEvent.click(screen.getByText("Remove"));
    await screen.findByText(/Remove Bob Jones as a friend\?/);

    // After the dialog opens, two "Remove" buttons exist: the row one and
    // the destructive confirm in the dialog footer. getAllByText returns
    // them in document order — the portaled footer one is last.
    const removeButtons = screen.getAllByText("Remove");
    const confirmButton = removeButtons[removeButtons.length - 1];
    fireEvent.click(confirmButton);

    // The call waits for any read of the list that is out (none here).
    await waitFor(() => expect(mocks.removeConnection).toHaveBeenCalledTimes(1));
    expect(mocks.removeConnection).toHaveBeenCalledWith("bob");
  });
});

describe("<ConnectionsPage /> — sent requests", () => {
  it("shows outgoing requests under the Sent tab and cancels via removeConnection", async () => {
    await renderConnectionsPage();
    mocks.listSentRequests.mockResolvedValue({
      sent: [
        { handle: "carol", displayName: "Carol Smith", requestedAt: new Date().toISOString() },
      ],
    });

    fireEvent.click(screen.getByText("Sent"));
    await screen.findByText("Carol Smith");

    fireEvent.click(screen.getByText("Cancel"));

    await waitFor(() => expect(mocks.removeConnection).toHaveBeenCalledTimes(1));
    expect(mocks.removeConnection).toHaveBeenCalledWith("carol");
  });

  it("shows an empty state when there are no outgoing requests", async () => {
    await renderConnectionsPage();

    fireEvent.click(screen.getByText("Sent"));
    const emptyState = await screen.findByText("No outgoing connection requests.");
    expect(emptyState).toBeDefined();
  });
});

describe("<ConnectionsPage /> — a row the list read in flight removes", () => {
  // A tab shown again is read again behind its rows. A row action pressed
  // meanwhile is busy, waits for that read, and does nothing if its row went.
  it("Accept waits for the read and sends nothing for a request that has gone", async () => {
    mocks.listPendingRequests.mockResolvedValueOnce({
      pending: [{ handle: "bob", displayName: "Bob Jones", requestedAt: new Date().toISOString() }],
    });
    await renderConnectionsPage();
    fireEvent.click(screen.getByText("Pending"));
    await screen.findByText("Bob Jones");

    // Away and back: Bob's row at once, a read held behind it.
    let answer!: (value: unknown) => void;
    mocks.listPendingRequests.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    fireEvent.click(screen.getByText("All"));
    fireEvent.click(screen.getByText("Pending"));
    expect(screen.getByText("Bob Jones")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Accept" }));
    expect(await screen.findByRole("button", { name: "Accepting…" })).toBeTruthy();
    answer({ pending: [] });
    await screen.findByText("No pending connection requests.");
    expect(mocks.acceptConnection).not.toHaveBeenCalled();
  });
});

describe("<ConnectionsPage /> — failed actions", () => {
  it.each([
    [new AuthExpiredError({}), "Your session has ended. Sign in again."],
    [new GraphClientError("Pending request not found", 400), "Pending request not found"],
    [new GraphClientError("", 400), "Failed to remove connection"],
  ])("toasts the right words when a removal fails", async (err, expected) => {
    await renderConnectionsPage();
    mocks.removeConnection.mockRejectedValue(err);
    const spy = vi.spyOn(toast, "error");

    fireEvent.click(screen.getByText("Remove"));
    await screen.findByText(/Remove Bob Jones as a friend\?/);
    const removeButtons = screen.getAllByText("Remove");
    fireEvent.click(removeButtons[removeButtons.length - 1]);

    await waitFor(() => expect(spy).toHaveBeenCalledWith(expected));
  });
});

describe("<ConnectionsPage /> — fallback sentences", () => {
  it.each([
    ["Pending", "Accept", "Failed to accept request"],
    ["Pending", "Decline", "Failed to reject request"],
    ["Sent", "Cancel", "Failed to cancel request"],
    ["Blocked", "Unblock", "Failed to unblock"],
  ])("falls back on the %s tab's %s button", async (tab, button, expected) => {
    await renderConnectionsPage();
    const row = {
      handle: "carol",
      displayName: "Carol Smith",
      requestedAt: new Date().toISOString(),
    };
    mocks.listPendingRequests.mockResolvedValue({ pending: [row] });
    mocks.listSentRequests.mockResolvedValue({ sent: [row] });
    mocks.listBlocks.mockResolvedValue({
      blocks: [{ handle: "carol", displayName: "Carol Smith" }],
    });
    for (const fn of [
      mocks.acceptConnection,
      mocks.rejectConnection,
      mocks.removeConnection,
      mocks.unblockProfile,
    ]) {
      fn.mockRejectedValue(new GraphClientError("", 400));
    }
    const spy = vi.spyOn(toast, "error");

    fireEvent.click(screen.getByText(tab));
    await screen.findByText(tab === "Blocked" ? "@carol" : "Carol Smith");
    fireEvent.click(screen.getByText(button));

    await waitFor(() => expect(spy).toHaveBeenCalledWith(expected));
  });
});
