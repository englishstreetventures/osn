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
  it("searches only while enabled, and never handles a token", async () => {
    // Signed out, the controller must stay off the network; the client sends
    // through the page's auth runtime, so no token reaches the call.
    await withRoot(async () => {
      const [enabled, setEnabled] = createSignal(false);
      const controller = createSearchController(enabled);

      controller.setQuery("ali");
      await settle();
      expect(mocks.search).not.toHaveBeenCalled();

      setEnabled(true);
      await settle();
      expect(mocks.search).toHaveBeenLastCalledWith("ali", expect.anything());
    });
  });

  it("keeps the previous page on screen while the next one loads", async () => {
    await withRoot(async () => {
      mocks.search.mockResolvedValue(page("alice"));
      const controller = createSearchController(() => true);

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
      const controller = createSearchController(() => true);

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
      mocks.search.mockImplementation((_q: string, opts: { signal?: AbortSignal }) => {
        captured = opts.signal;
        return new Promise(() => {});
      });
      const controller = createSearchController(() => true);

      controller.setQuery("ali");
      await settle();
      expect(captured?.aborted).toBe(false);

      dispose();
      expect(captured?.aborted).toBe(true);
    });
  });

  it("does not query below the minimum length, and strips a leading @", async () => {
    await withRoot(async () => {
      const controller = createSearchController(() => true);

      // The floor is one character, not two: the server answers a single
      // character from the caller's own connections and organisations, so
      // suppressing it here would drop that first-keystroke answer entirely.
      // Only a query with nothing left after normalisation is too short.
      controller.setQuery("@");
      await settle();
      expect(mocks.search).not.toHaveBeenCalled();
      expect(controller.tooShort()).toBe(true);

      controller.setQuery("@a");
      await settle();
      expect(controller.tooShort()).toBe(false);
      expect(mocks.search).toHaveBeenCalledWith("a", expect.anything());

      controller.setQuery("@ab");
      await settle();
      expect(mocks.search).toHaveBeenCalledWith("ab", expect.anything());
    });
  });

  it("orders the flat list people-first for arrow-key navigation", async () => {
    await withRoot(async () => {
      mocks.search.mockResolvedValue({
        people: [{ handle: "alice", displayName: null, avatarUrl: null, connectionStatus: "none" }],
        organisations: [{ handle: "acme", name: "Acme Inc", avatarUrl: null, isMember: false }],
      });
      const controller = createSearchController(() => true);

      controller.setQuery("ac");
      await settle();
      expect(controller.flat().map((r) => r.kind)).toEqual(["person", "organisation"]);
    });
  });
});
