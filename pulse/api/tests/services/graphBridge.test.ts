import { Effect } from "effect";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @osn/crypto so key generation never hits the real Web Crypto API.
// generateArcKeyPair is slow (> 5 s) in the test environment; mocking it
// keeps all graphBridge tests under the default 5000 ms timeout.
vi.mock("@osn/crypto", () => ({
  generateArcKeyPair: vi.fn().mockResolvedValue({
    privateKey: {} as CryptoKey,
    publicKey: {} as CryptoKey,
  }),
  importKeyFromJwk: vi.fn().mockResolvedValue({} as CryptoKey),
  getOrCreateArcToken: vi.fn().mockResolvedValue("test-arc-token"),
}));

import { MAX_EVENT_GUESTS } from "../../src/lib/limits";
import {
  getCloseFriendIds,
  getCloseFriendsOf,
  getConnectionIds,
  getProfileDisplays,
} from "../../src/services/graphBridge";

// graphBridge is the single seam between Pulse and the OSN social graph.
// It makes ARC-authenticated HTTP calls to osn/api; this test suite mocks
// fetch so we can verify the request/response mapping without a live server.

function mockFetch(response: unknown, status = 200) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
    new Response(JSON.stringify(response), {
      status,
      headers: { "content-type": "application/json" },
    }),
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ── getConnectionIds ─────────────────────────────────────────────────────────

describe("getConnectionIds", () => {
  it("returns a Set of connection IDs from the API response", async () => {
    mockFetch({ connectionIds: ["usr_bob", "usr_carol"] });
    const result = await Effect.runPromise(getConnectionIds("usr_alice"));
    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(2);
    expect(result.has("usr_bob")).toBe(true);
    expect(result.has("usr_carol")).toBe(true);
  });

  it("returns an empty Set when the API returns an empty list", async () => {
    mockFetch({ connectionIds: [] });
    const result = await Effect.runPromise(getConnectionIds("usr_alice"));
    expect(result.size).toBe(0);
  });

  it("calls the correct endpoint with profileId and limit encoded", async () => {
    const spy = mockFetch({ connectionIds: [] });
    await Effect.runPromise(getConnectionIds("usr_alice"));
    const url = (spy.mock.calls[0]![0] as string).split("?")[0];
    expect(url).toContain("/graph/internal/connections");
    const search = new URLSearchParams((spy.mock.calls[0]![0] as string).split("?")[1]);
    expect(search.get("profileId")).toBe("usr_alice");
    expect(search.get("limit")).toBe(String(MAX_EVENT_GUESTS));
  });

  it("sends ARC Authorization header on GET requests", async () => {
    const spy = mockFetch({ connectionIds: [] });
    await Effect.runPromise(getConnectionIds("usr_alice"));
    const headers = spy.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["authorization"]).toMatch(/^ARC /);
  });

  it("fails with GraphBridgeError on HTTP error", async () => {
    mockFetch({ error: "Unauthorized" }, 401);
    const err = await Effect.runPromise(Effect.flip(getConnectionIds("usr_alice")));
    expect(err._tag).toBe("GraphBridgeError");
  });
});

// ── getCloseFriendIds ────────────────────────────────────────────────────────

describe("getCloseFriendIds", () => {
  it("returns a Set of close friend IDs", async () => {
    mockFetch({ closeFriendIds: ["usr_bob"] });
    const result = await Effect.runPromise(getCloseFriendIds("usr_alice"));
    expect(result).toBeInstanceOf(Set);
    expect(result.has("usr_bob")).toBe(true);
  });

  it("returns an empty Set when API returns empty list", async () => {
    mockFetch({ closeFriendIds: [] });
    const result = await Effect.runPromise(getCloseFriendIds("usr_alice"));
    expect(result.size).toBe(0);
  });

  it("fails with GraphBridgeError on HTTP error", async () => {
    mockFetch({ error: "Unauthorized" }, 401);
    const err = await Effect.runPromise(Effect.flip(getCloseFriendIds("usr_alice")));
    expect(err._tag).toBe("GraphBridgeError");
  });
});

// ── getCloseFriendsOf ────────────────────────────────────────────────────────

describe("getCloseFriendsOf", () => {
  it("short-circuits with empty Set when attendeeIds is empty (no HTTP call)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await Effect.runPromise(getCloseFriendsOf("usr_alice", []));
    expect(result.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns the subset of attendee IDs the API reports as close friends of viewerId", async () => {
    mockFetch({ closeFriendIds: ["usr_bob", "usr_carol"] });
    const result = await Effect.runPromise(
      getCloseFriendsOf("usr_alice", ["usr_bob", "usr_carol", "usr_dan"]),
    );
    expect(result.size).toBe(2);
    expect(result.has("usr_bob")).toBe(true);
    expect(result.has("usr_carol")).toBe(true);
    expect(result.has("usr_dan")).toBe(false);
  });

  it("sends a POST with viewerId and profileIds in the body", async () => {
    const spy = mockFetch({ closeFriendIds: [] });
    await Effect.runPromise(getCloseFriendsOf("usr_alice", ["usr_bob"]));
    expect(spy.mock.calls[0]![1]?.method).toBe("POST");
    const body = JSON.parse(spy.mock.calls[0]![1]?.body as string) as unknown;
    expect(body).toMatchObject({ viewerId: "usr_alice", profileIds: ["usr_bob"] });
  });

  it("sends ARC Authorization header on POST requests", async () => {
    const spy = mockFetch({ closeFriendIds: [] });
    await Effect.runPromise(getCloseFriendsOf("usr_alice", ["usr_bob"]));
    const headers = spy.mock.calls[0]![1]?.headers as Record<string, string>;
    expect(headers["authorization"]).toMatch(/^ARC /);
  });

  it("fails with GraphBridgeError on HTTP error", async () => {
    mockFetch({ error: "Unauthorized" }, 401);
    const err = await Effect.runPromise(Effect.flip(getCloseFriendsOf("usr_alice", ["usr_bob"])));
    expect(err._tag).toBe("GraphBridgeError");
  });
});

// ── getProfileDisplays ──────────────────────────────────────────────────────

describe("getProfileDisplays", () => {
  it("short-circuits with empty Map when profileIds is empty (no HTTP call)", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await Effect.runPromise(getProfileDisplays([]));
    expect(result.size).toBe(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns a Map keyed by profile ID", async () => {
    mockFetch({
      profiles: [
        { id: "usr_alice", handle: "alice", displayName: "Alice", avatarUrl: null },
        { id: "usr_bob", handle: "bob", displayName: "Bob Smith", avatarUrl: null },
      ],
    });
    const result = await Effect.runPromise(getProfileDisplays(["usr_alice", "usr_bob"]));
    expect(result.size).toBe(2);
    expect(result.get("usr_alice")?.displayName).toBe("Alice");
    expect(result.get("usr_bob")?.handle).toBe("bob");
  });

  it("omits IDs that the API doesn't return (unknown profiles)", async () => {
    mockFetch({
      profiles: [{ id: "usr_alice", handle: "alice", displayName: "Alice", avatarUrl: null }],
    });
    const result = await Effect.runPromise(getProfileDisplays(["usr_alice", "usr_ghost"]));
    expect(result.size).toBe(1);
    expect(result.has("usr_alice")).toBe(true);
    expect(result.has("usr_ghost")).toBe(false);
  });

  it("fails with GraphBridgeError on HTTP error", async () => {
    mockFetch({ error: "Unauthorized" }, 401);
    const err = await Effect.runPromise(Effect.flip(getProfileDisplays(["usr_alice"])));
    expect(err._tag).toBe("GraphBridgeError");
  });
});
