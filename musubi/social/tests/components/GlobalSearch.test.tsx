// @vitest-environment happy-dom

import { MemoryRouter, Route } from "@solidjs/router";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the API clients before importing the component under test so its
// module-level `recommendationClient` / `graphClient` references pick up the
// mocked implementations.
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

import { GlobalSearch } from "../../src/components/GlobalSearch";

const person = (handle: string, connectionStatus = "none", displayName: string | null = null) => ({
  handle,
  displayName,
  avatarUrl: null,
  connectionStatus,
});

const org = (handle: string, name: string, isMember = false) => ({
  handle,
  name,
  avatarUrl: null,
  isMember,
});

const results = (
  people: ReturnType<typeof person>[] = [],
  organisations: ReturnType<typeof org>[] = [],
) => ({ people, organisations });

function renderSearch() {
  return render(() => (
    <MemoryRouter>
      <Route path="/" component={() => <GlobalSearch token="tkn" />} />
      {/* Landing marker: MemoryRouter never touches window.location, so a
          rendered destination is how we observe that navigation happened. */}
      <Route path="/organisations/:handle" component={() => <p>org detail</p>} />
    </MemoryRouter>
  ));
}

/** Types into the combobox and lets the debounce timer fire. */
async function type(value: string) {
  const input = screen.getByRole("combobox");
  fireEvent.input(input, { target: { value } });
  await vi.advanceTimersByTimeAsync(300);
  return input;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.search.mockResolvedValue(results());
  mocks.sendConnectionRequest.mockResolvedValue({ ok: true });
  mocks.acceptConnection.mockResolvedValue({ ok: true });
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
  vi.clearAllMocks();
});

describe("<GlobalSearch />", () => {
  it("renders a decorative @ prefix ahead of the input", () => {
    renderSearch();
    const prefix = screen.getByText("@", { selector: "span" });
    expect(prefix).toBeDefined();
    expect(prefix.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not query the API for a query that normalises to nothing", async () => {
    renderSearch();
    // A bare sigil leaves no query at all. One real character does search —
    // the server scopes it to the caller's own connections and organisations.
    await type("@");
    expect(mocks.search).not.toHaveBeenCalled();

    await type("a");
    expect(mocks.search).toHaveBeenCalledWith("tkn", "a", expect.anything());
  });

  it("debounces so a burst of keystrokes issues a single request", async () => {
    renderSearch();
    const input = screen.getByRole("combobox");
    for (const value of ["al", "ali", "alic", "alice"]) {
      fireEvent.input(input, { target: { value } });
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(300);

    expect(mocks.search).toHaveBeenCalledTimes(1);
    expect(mocks.search).toHaveBeenCalledWith(
      "tkn",
      "alice",
      expect.objectContaining({ limit: 6 }),
    );
  });

  it("strips a leading @ before querying", async () => {
    renderSearch();
    await type("@alice");
    expect(mocks.search).toHaveBeenCalledWith("tkn", "alice", expect.anything());
  });

  it("renders people and organisations as one flat listbox, people first", async () => {
    mocks.search.mockResolvedValue(
      results([person("alice"), person("alicia")], [org("aligned", "Aligned Co")]),
    );
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));
    const options = screen.getAllByRole("option");
    expect(options[0]!.textContent).toContain("alice");
    expect(options[2]!.textContent).toContain("Aligned Co");
  });

  it("puts no operable control inside a listbox option", async () => {
    // An ARIA listbox option is flattened to its accessible name by assistive
    // tech, so a nested button or link is announced as text and cannot be
    // triggered. The option itself must be the activation target.
    mocks.search.mockResolvedValue(results([person("alice")], [org("aligned", "Aligned Co")]));
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    for (const option of screen.getAllByRole("option")) {
      expect(option.querySelector("button, a")).toBeNull();
    }
  });

  it("names each option after what activating it will do", async () => {
    mocks.search.mockResolvedValue(
      results([person("alice", "pending_received", "Alice A")], [org("acme", "Acme Inc", true)]),
    );
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));
    const [personOption, orgOption] = screen.getAllByRole("option");
    expect(personOption!.getAttribute("aria-label")).toBe(
      "Alice A, @alice, accept connection request",
    );
    expect(orgOption!.getAttribute("aria-label")).toBe(
      "Acme Inc, @acme, member, open organisation",
    );
  });

  it("connects by clicking the option row itself", async () => {
    mocks.search.mockResolvedValue(results([person("alice")]));
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));
    fireEvent.click(screen.getByRole("option"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.sendConnectionRequest).toHaveBeenCalledWith("tkn", "alice");
  });

  it("marks an organisation the caller already belongs to", async () => {
    mocks.search.mockResolvedValue(results([], [org("acme", "Acme Inc", true)]));
    renderSearch();
    await type("acme");

    await waitFor(() => expect(screen.getByText("Member")).toBeDefined());
  });

  it("flips the row to the sent state without refetching", async () => {
    mocks.search.mockResolvedValue(results([person("alice")]));
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getByText("Connect")).toBeDefined());
    fireEvent.click(screen.getByRole("option"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.sendConnectionRequest).toHaveBeenCalledWith("tkn", "alice");
    await waitFor(() => expect(screen.getByText("Requested")).toBeDefined());
  });

  it("accepts instead of connecting when they asked first", async () => {
    mocks.search.mockResolvedValue(results([person("alice", "pending_received")]));
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getByText("Accept")).toBeDefined());
    fireEvent.click(screen.getByRole("option"));
    await vi.advanceTimersByTimeAsync(0);

    expect(mocks.acceptConnection).toHaveBeenCalledWith("tkn", "alice");
    expect(mocks.sendConnectionRequest).not.toHaveBeenCalled();
  });

  it("does not flip the row when the connect request fails", async () => {
    mocks.search.mockResolvedValue(results([person("alice")]));
    mocks.sendConnectionRequest.mockRejectedValue(new Error("boom"));
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getByText("Connect")).toBeDefined());
    fireEvent.click(screen.getByRole("option"));
    await vi.advanceTimersByTimeAsync(0);

    // A request that never landed must not read as sent.
    await waitFor(() => expect(screen.getByText("Connect")).toBeDefined());
    expect(screen.queryByText("Requested")).toBeNull();
  });

  it("surfaces a failed search instead of spinning forever", async () => {
    mocks.search.mockRejectedValue(new Error("Rate limited"));
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getByText(/Search is unavailable/)).toBeDefined());
    expect(screen.queryByText("Searching…")).toBeNull();
  });

  it("shows a non-actionable label for results already connected or requested", async () => {
    mocks.search.mockResolvedValue(
      results([person("alice", "connected"), person("alicia", "pending_sent")]),
    );
    renderSearch();
    await type("ali");

    await waitFor(() => expect(screen.getByText("Connected")).toBeDefined());
    expect(screen.getByText("Requested")).toBeDefined();
    expect(screen.queryByText("Connect")).toBeNull();
  });

  it("moves the active option with the arrow keys and acts on Enter", async () => {
    mocks.search.mockResolvedValue(results([person("alice"), person("alicia")]));
    renderSearch();
    const input = await type("ali");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("global-search-option-1");

    fireEvent.keyDown(input, { key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sendConnectionRequest).toHaveBeenCalledWith("tkn", "alicia");
  });

  it("walks past the people section into organisations with the arrow keys", async () => {
    mocks.search.mockResolvedValue(results([person("alice")], [org("acme", "Acme Inc")]));
    renderSearch();
    const input = await type("a");
    fireEvent.input(input, { target: { value: "ac" } });
    await vi.advanceTimersByTimeAsync(300);
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(2));

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(input.getAttribute("aria-activedescendant")).toBe("global-search-option-1");

    // Enter on an organisation navigates rather than firing a graph write.
    fireEvent.keyDown(input, { key: "Enter" });
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.sendConnectionRequest).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("org detail")).toBeDefined());
  });

  it("wraps to the last option on ArrowUp from an inactive field", async () => {
    mocks.search.mockResolvedValue(results([person("alice"), person("alicia"), person("alina")]));
    renderSearch();
    const input = await type("ali");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(3));

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(input.getAttribute("aria-activedescendant")).toBe("global-search-option-2");
  });

  it("closes the listbox on Escape", async () => {
    mocks.search.mockResolvedValue(results([person("alice")]));
    renderSearch();
    const input = await type("ali");
    await waitFor(() => expect(screen.getAllByRole("option")).toHaveLength(1));

    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("option")).toBeNull();
    expect(input.getAttribute("aria-expanded")).toBe("false");
  });

  it("reports an empty result set instead of leaving the panel blank", async () => {
    mocks.search.mockResolvedValue(results());
    renderSearch();
    await type("zzz");

    await waitFor(() => expect(screen.getByText(/No results for "zzz"/)).toBeDefined());
  });

  it("passes an abort signal so a superseded request can be cancelled", async () => {
    renderSearch();
    await type("ali");
    const options = mocks.search.mock.calls[0]![2] as { signal?: AbortSignal };
    expect(options.signal).toBeInstanceOf(AbortSignal);
    expect(options.signal!.aborted).toBe(false);
  });
});
