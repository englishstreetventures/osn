// @vitest-environment happy-dom

import { createRoot, createSignal } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("../../src/lib/api", () => ({
  graphClient: {},
  orgClient: {},
  recommendationClient: { search: mocks.search },
}));

import { createSearchController } from "../../src/lib/search";

const EMPTY = { people: [], organisations: [] };
const page = (handle: string) => ({
  people: [{ handle, displayName: null, avatarUrl: null, connectionStatus: "none" }],
  organisations: [],
});

/** Runs `body` inside a reactive root and disposes it afterwards. */
async function withRoot<T>(body: (dispose: () => void) => Promise<T>): Promise<T> {
  let dispose!: () => void;
  const result = createRoot((d) => {
    dispose = d;
    return body(d);
  });
  try {
    return await result;
  } finally {
    dispose();
  }
}

/** Advances past the debounce and lets the resource settle. */
const settle = () => vi.advanceTimersByTimeAsync(300);

beforeEach(() => {
  vi.useFakeTimers();
  mocks.search.mockResolvedValue(EMPTY);
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("createSearchController", () => {
  it("re-reads the token accessor on each request", async () => {
    // The contract that lets one controller outlive a silent token refresh.
    // Access tokens have a 5-minute TTL, so capturing the token by value would
    // 401 every user shortly after mount — and no component test catches it,
    // because they all pass a constant token.
    await withRoot(async () => {
      const [token, setToken] = createSignal("tkn-1");
      const controller = createSearchController(token);

      controller.setQuery("ali");
      await settle();
      expect(mocks.search).toHaveBeenLastCalledWith("tkn-1", "ali", expect.anything());

      setToken("tkn-2");
      controller.setQuery("alic");
      await settle();
      expect(mocks.search).toHaveBeenLastCalledWith("tkn-2", "alic", expect.anything());
    });
  });

  it("does not refetch when only the token changes", async () => {
    // A token refresh must not refire an identical query — on desktop two
    // controllers are mounted at once, so that would be two wasted scans.
    await withRoot(async () => {
      const [token, setToken] = createSignal("tkn-1");
      const controller = createSearchController(token);

      controller.setQuery("ali");
      await settle();
      expect(mocks.search).toHaveBeenCalledTimes(1);

      setToken("tkn-2");
      await settle();
      expect(mocks.search).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the previous page on screen while the next one loads", async () => {
    await withRoot(async () => {
      mocks.search.mockResolvedValue(page("alice"));
      const controller = createSearchController(() => "tkn");

      controller.setQuery("ali");
      await settle();
      expect(controller.people().map((p) => p.handle)).toEqual(["alice"]);

      // Next request in flight: the list must not blank out between keystrokes.
      let release!: (value: unknown) => void;
      mocks.search.mockReturnValue(new Promise((resolve) => (release = resolve)));
      controller.setQuery("alic");
      await settle();

      expect(controller.loading()).toBe(true);
      expect(controller.people().map((p) => p.handle)).toEqual(["alice"]);

      release(page("alicia"));
      await settle();
      expect(controller.people().map((p) => p.handle)).toEqual(["alicia"]);
    });
  });

  it("reports a failed request instead of leaking an unhandled rejection", async () => {
    await withRoot(async () => {
      mocks.search.mockRejectedValue(new Error("Rate limited"));
      const controller = createSearchController(() => "tkn");

      controller.setQuery("ali");
      await settle();

      expect(controller.failed()).toBe(true);
      expect(controller.loading()).toBe(false);
      // Reading results must stay safe — `latest` rethrows in the error state.
      expect(controller.people()).toEqual([]);
      expect(controller.flat()).toEqual([]);
    });
  });

  it("aborts the in-flight request when the controller is disposed", async () => {
    await withRoot(async (dispose) => {
      let captured: AbortSignal | undefined;
      mocks.search.mockImplementation((_t: string, _q: string, opts: { signal?: AbortSignal }) => {
        captured = opts.signal;
        return new Promise(() => {});
      });
      const controller = createSearchController(() => "tkn");

      controller.setQuery("ali");
      await settle();
      expect(captured?.aborted).toBe(false);

      dispose();
      expect(captured?.aborted).toBe(true);
    });
  });

  it("does not query below the minimum length, and strips a leading @", async () => {
    await withRoot(async () => {
      const controller = createSearchController(() => "tkn");

      controller.setQuery("@a");
      await settle();
      expect(mocks.search).not.toHaveBeenCalled();
      expect(controller.tooShort()).toBe(true);

      controller.setQuery("@ab");
      await settle();
      expect(mocks.search).toHaveBeenCalledWith("tkn", "ab", expect.anything());
    });
  });

  it("orders the flat list people-first for arrow-key navigation", async () => {
    await withRoot(async () => {
      mocks.search.mockResolvedValue({
        people: [{ handle: "alice", displayName: null, avatarUrl: null, connectionStatus: "none" }],
        organisations: [{ handle: "acme", name: "Acme Inc", avatarUrl: null, isMember: false }],
      });
      const controller = createSearchController(() => "tkn");

      controller.setQuery("ac");
      await settle();
      expect(controller.flat().map((r) => r.kind)).toEqual(["person", "organisation"]);
    });
  });
});
