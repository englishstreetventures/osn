// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the graph client before importing the page under test so the
// page's `graphClient` reference picks up the mocked implementation.
const mocks = vi.hoisted(() => ({
  listConnections: vi.fn(),
  listPendingRequests: vi.fn(),
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
  const authValue = {
    session: Object.assign(
      () => ({
        accessToken: "tkn",
        idToken: null,
        expiresAt: Date.now() + 60_000,
        scopes: [],
      }),
      {
        state: "ready",
        loading: false,
        error: undefined,
        latest: null,
        refetch: () => {},
        mutate: () => {},
      },
    ),
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
  cleanup();
  vi.clearAllMocks();
});

describe("<ConnectionsPage /> — remove friend confirmation", () => {
  it("opens a confirmation dialog and does not call the API when clicking Remove on a row", async () => {
    await renderConnectionsPage();

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

    expect(mocks.removeConnection).toHaveBeenCalledTimes(1);
    expect(mocks.removeConnection).toHaveBeenCalledWith("tkn", "bob");
  });
});
