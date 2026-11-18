// @vitest-environment happy-dom
import { AuthExpiredError, GraphClientError } from "@osn/client";
import { AuthContext } from "@osn/client/solid";
import { toast } from "@shared/toast";
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  suggestConnections: vi.fn(),
  sendConnectionRequest: vi.fn(),
  acceptConnection: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  graphClient: {
    sendConnectionRequest: mocks.sendConnectionRequest,
    acceptConnection: mocks.acceptConnection,
  },
  orgClient: {},
  recommendationClient: {
    suggestConnections: mocks.suggestConnections,
  },
}));

import { DiscoverPage } from "../../src/pages/DiscoverPage";

function authedProvider() {
  // `latest` is the value, as a landed resource's is: the page cache keys on
  // the session object, so each render's new one gives each test a fresh cache.
  const asResource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: value,
      refetch: () => {},
      mutate: () => {},
    });

  return {
    session: asResource({
      accessToken: "tkn",
      idToken: null,
      expiresAt: Date.now() + 60_000,
      scopes: [],
    }),
    profiles: asResource([]),
    activeProfileId: () => "usr_1",
    logout: () => Promise.resolve(),
    adoptSession: () => Promise.resolve(),
    switchProfile: () => Promise.reject(new Error("unused")),
    createProfile: () => Promise.reject(new Error("unused")),
    deleteProfile: () => Promise.resolve(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mocked AuthContext; full interface fidelity not required for this test
  } as any;
}

const suggestion = (overrides: Record<string, unknown>) => ({
  handle: "bob",
  displayName: null,
  avatarUrl: null,
  mutualCount: 0,
  reason: "shared_organisation",
  sharedOrganisation: null,
  ...overrides,
});

function renderDiscover(auth = authedProvider()) {
  // The empty state links to /search, so the page needs a router in scope.
  return render(() => (
    <AuthContext.Provider value={auth}>
      <MemoryRouter>
        <Route path="/" component={DiscoverPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

beforeEach(() => {
  mocks.suggestConnections.mockResolvedValue({ suggestions: [] });
  mocks.sendConnectionRequest.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.restoreAllMocks();
  cleanup();
  vi.clearAllMocks();
});

describe("<DiscoverPage />", () => {
  it("explains a friends-of-friends suggestion with its mutual count", async () => {
    mocks.suggestConnections.mockResolvedValue({
      suggestions: [suggestion({ reason: "mutual_connections", mutualCount: 3 })],
    });
    renderDiscover();
    expect(await screen.findByText("3 mutual connections")).toBeDefined();
    expect(document.title).toBe("Discover · Musubi");
  });

  it("singularises a lone mutual connection", async () => {
    mocks.suggestConnections.mockResolvedValue({
      suggestions: [suggestion({ reason: "mutual_connections", mutualCount: 1 })],
    });
    renderDiscover();
    expect(await screen.findByText("1 mutual connection")).toBeDefined();
  });

  it("names the shared organisation for a cold-start suggestion", async () => {
    mocks.suggestConnections.mockResolvedValue({
      suggestions: [
        suggestion({
          reason: "shared_organisation",
          sharedOrganisation: { handle: "acme", name: "Acme Inc" },
        }),
      ],
    });
    renderDiscover();
    expect(await screen.findByText("Also in Acme Inc")).toBeDefined();
  });

  it("sends a connection request from a suggestion card", async () => {
    mocks.suggestConnections.mockResolvedValue({
      suggestions: [suggestion({ reason: "mutual_connections", mutualCount: 2 })],
    });
    renderDiscover();
    fireEvent.click(await screen.findByText("Connect"));

    await waitFor(() => expect(mocks.sendConnectionRequest).toHaveBeenCalledWith("bob"));
  });

  it("points an empty suggestion list at search rather than a dead end", async () => {
    renderDiscover();
    const link = await screen.findByText("Search for someone");
    expect(link.getAttribute("href")).toBe("/search");
  });

  it("words an ended session as a sentence in the toast", async () => {
    mocks.suggestConnections.mockResolvedValue({
      suggestions: [suggestion({ reason: "mutual_connections", mutualCount: 2 })],
    });
    mocks.sendConnectionRequest.mockRejectedValue(new AuthExpiredError({}));
    const spy = vi.spyOn(toast, "error");
    renderDiscover();
    fireEvent.click(await screen.findByText("Connect"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("Your session has ended. Sign in again."));
  });

  it.each([
    [
      "shows the error's own message for an ordinary failure",
      "Connection already exists",
      "Connection already exists",
    ],
    [
      "falls back to the fixed sentence when the error has no message",
      "",
      "Failed to send request",
    ],
  ])("%s", async (_name, message, expected) => {
    mocks.suggestConnections.mockResolvedValue({
      suggestions: [suggestion({ reason: "mutual_connections", mutualCount: 2 })],
    });
    mocks.sendConnectionRequest.mockRejectedValue(new GraphClientError(message, 400));
    const spy = vi.spyOn(toast, "error");
    renderDiscover();
    fireEvent.click(await screen.findByText("Connect"));
    await waitFor(() => expect(spy).toHaveBeenCalledWith(expected));
  });
});

describe("<DiscoverPage /> — a card the read in flight removes", () => {
  // Shown again, the suggestions draw at once and are read again behind
  // them. A Connect pressed meanwhile is busy, waits for that read, and sends
  // nothing for a card it took off.
  it("Connect waits for the read and sends no request for a card that has gone", async () => {
    const auth = authedProvider();
    mocks.suggestConnections.mockResolvedValueOnce({
      suggestions: [suggestion({ reason: "mutual_connections", mutualCount: 2 })],
    });
    const first = renderDiscover(auth);
    await screen.findByText("Connect");
    first.unmount();

    let answer!: (value: unknown) => void;
    mocks.suggestConnections.mockReturnValueOnce(
      new Promise((resolve) => {
        answer = resolve;
      }),
    );
    renderDiscover(auth);
    fireEvent.click(screen.getByText("Connect"));
    expect(await screen.findByText("Sending…")).toBeDefined();
    answer({ suggestions: [] });
    await screen.findByText("Search for someone");
    expect(mocks.sendConnectionRequest).not.toHaveBeenCalled();
  });
});
