// @vitest-environment happy-dom
import { AuthContext } from "@osn/client/solid";
import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(),
  sendConnectionRequest: vi.fn(),
  acceptConnection: vi.fn(),
}));

vi.mock("../../src/lib/api", () => ({
  graphClient: {
    sendConnectionRequest: mocks.sendConnectionRequest,
    acceptConnection: mocks.acceptConnection,
  },
  orgClient: {},
  recommendationClient: { search: mocks.search },
}));

import { SearchPage } from "../../src/pages/SearchPage";

function authedProvider(signedIn = true) {
  const asResource = <T,>(value: T) =>
    Object.assign(() => value, {
      state: "ready",
      loading: false,
      error: undefined,
      latest: null,
      refetch: () => {},
      mutate: () => {},
    });

  return {
    session: asResource(
      signedIn
        ? { accessToken: "tkn", idToken: null, expiresAt: Date.now() + 60_000, scopes: [] }
        : null,
    ),
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

const person = (handle: string, connectionStatus = "none") => ({
  handle,
  displayName: null,
  avatarUrl: null,
  connectionStatus,
});

const org = (handle: string, name: string, isMember = false) => ({
  handle,
  name,
  avatarUrl: null,
  isMember,
});

function renderPage(signedIn = true) {
  return render(() => (
    <AuthContext.Provider value={authedProvider(signedIn)}>
      <MemoryRouter>
        <Route path="/" component={SearchPage} />
      </MemoryRouter>
    </AuthContext.Provider>
  ));
}

async function type(value: string) {
  const input = screen.getByLabelText("Search people and organisations");
  fireEvent.input(input, { target: { value } });
  await vi.advanceTimersByTimeAsync(300);
  return input;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.search.mockResolvedValue({ people: [], organisations: [] });
  mocks.sendConnectionRequest.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe("<SearchPage />", () => {
  it("renders a decorative @ prefix ahead of the input", () => {
    renderPage();
    const prefix = screen.getByText("@", { selector: "span" });
    expect(prefix).toBeDefined();
    expect(prefix.getAttribute("aria-hidden")).toBe("true");
  });

  it("prompts before searching, and searches from the first character", async () => {
    renderPage();
    expect(screen.getByText(/Start typing to find people/)).toBeDefined();
    expect(mocks.search).not.toHaveBeenCalled();

    // One character is a real search — the server scopes it to the caller's own
    // connections and organisations rather than the global index.
    await type("a");
    expect(mocks.search).toHaveBeenCalledWith("tkn", "a", expect.anything());
  });

  it("groups results under People and Organisations headings", async () => {
    mocks.search.mockResolvedValue({
      people: [person("alice")],
      organisations: [org("aligned", "Aligned Co")],
    });
    renderPage();
    await type("ali");

    await waitFor(() => expect(screen.getByText("People")).toBeDefined());
    expect(screen.getByText("Organisations")).toBeDefined();
    expect(screen.getByText("Aligned Co")).toBeDefined();
  });

  it("omits a section that has no results", async () => {
    mocks.search.mockResolvedValue({ people: [person("alice")], organisations: [] });
    renderPage();
    await type("ali");

    await waitFor(() => expect(screen.getByText("People")).toBeDefined());
    expect(screen.queryByText("Organisations")).toBeNull();
  });

  it("requests a longer page than the rail dropdown", async () => {
    renderPage();
    await type("ali");
    expect(mocks.search).toHaveBeenCalledWith(
      "tkn",
      "ali",
      expect.objectContaining({ limit: 15, orgLimit: 8 }),
    );
  });

  it("connects to a person from the result list", async () => {
    mocks.search.mockResolvedValue({ people: [person("alice")], organisations: [] });
    renderPage();
    await type("ali");

    await waitFor(() => expect(screen.getByText("Connect")).toBeDefined());
    fireEvent.click(screen.getByText("Connect"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.sendConnectionRequest).toHaveBeenCalledWith("tkn", "alice");
    await waitFor(() => expect(screen.getByText("Requested")).toBeDefined());
  });

  it("reports an empty result set", async () => {
    renderPage();
    await type("zzz");
    await waitFor(() => expect(screen.getByText(/No results for "zzz"/)).toBeDefined());
  });

  it("surfaces a failed search instead of spinning forever", async () => {
    mocks.search.mockRejectedValue(new Error("Rate limited"));
    renderPage();
    await type("ali");

    await waitFor(() => expect(screen.getByText(/Search is unavailable/)).toBeDefined());
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("does not flip the row when the connect request fails", async () => {
    mocks.search.mockResolvedValue({ people: [person("alice")], organisations: [] });
    mocks.sendConnectionRequest.mockRejectedValue(new Error("boom"));
    renderPage();
    await type("ali");

    await waitFor(() => expect(screen.getByText("Connect")).toBeDefined());
    fireEvent.click(screen.getByText("Connect"));
    await vi.advanceTimersByTimeAsync(0);

    await waitFor(() => expect(screen.getByText("Connect")).toBeDefined());
    expect(screen.queryByText("Requested")).toBeNull();
  });

  it("links an organisation to its handle-addressed detail page", async () => {
    mocks.search.mockResolvedValue({ people: [], organisations: [org("acme", "Acme Inc")] });
    renderPage();
    await type("acme");

    await waitFor(() => expect(screen.getByRole("link")).toBeDefined());
    // Handle, not the org_* id — that is what GET /organisations/:handle resolves.
    expect(screen.getByRole("link").getAttribute("href")).toBe("/organisations/acme");
  });

  it("asks a signed-out visitor to sign in rather than showing a dead input", async () => {
    renderPage(false);
    expect(screen.getByText(/Sign in to search/)).toBeDefined();
    expect(screen.queryByLabelText("Search people and organisations")).toBeNull();
  });
});
