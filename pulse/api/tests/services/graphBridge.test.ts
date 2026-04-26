import { Effect } from "effect";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock @shared/crypto so key generation never hits the real Web Crypto API.
// generateArcKeyPair is slow (> 5 s) in the test environment; mocking it
// keeps all graphBridge tests under the default 5000 ms timeout.
vi.mock("@shared/crypto", () => ({
  generateArcKeyPair: vi.fn().mockResolvedValue({
    privateKey: {} as CryptoKey,
    publicKey: {} as CryptoKey,
  }),
  exportKeyToJwk: vi.fn().mockResolvedValue('{"kty":"EC","crv":"P-256","x":"stub","y":"stub"}'),
  importKeyFromJwk: vi.fn().mockResolvedValue({} as CryptoKey),
  getOrCreateArcToken: vi.fn().mockResolvedValue("test-arc-token"),
}));

import { MAX_EVENT_GUESTS } from "../../src/lib/limits";
import {
  getCloseFriendIds,
  getCloseFriendsOf,
  getConnectionIds,
  getProfileDisplays,
  startKeyRotation,
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

// ── startKeyRotation (T-U2) ──────────────────────────────────────────────────

describe("startKeyRotation", () => {
  const SECRET = "test-internal-secret";

  beforeEach(() => {
    vi.stubEnv("INTERNAL_SERVICE_SECRET", SECRET);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it("throws when INTERNAL_SERVICE_SECRET is unset in a non-local environment", async () => {
    vi.unstubAllEnvs(); // undo beforeEach stub so the env var is absent
    vi.stubEnv("OSN_ENV", "production");
    await expect(startKeyRotation()).rejects.toThrow("INTERNAL_SERVICE_SECRET must be set");
  });

  it("returns skipped-secret-unset (and makes no HTTP call) when the secret is unset in local dev", async () => {
    vi.unstubAllEnvs(); // remove the SECRET stub
    // OSN_ENV unset → treated as local
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(startKeyRotation()).resolves.toBe("skipped-secret-unset");
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns skipped-secret-unset when OSN_ENV=local and the secret is unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("OSN_ENV", "local");
    const spy = vi.spyOn(globalThis, "fetch");
    await expect(startKeyRotation()).resolves.toBe("skipped-secret-unset");
    expect(spy).not.toHaveBeenCalled();
  });

  it("makes a POST to /graph/internal/register-service with correct shape", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(startKeyRotation()).resolves.toBe("registered");

    expect(spy).toHaveBeenCalledOnce();
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/graph/internal/register-service");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string) as Record<string, unknown>;
    expect(body.serviceId).toBe("pulse-api");
    expect(body.allowedScopes).toBe("graph:read");
    expect(typeof body.keyId).toBe("string");
    expect(typeof body.publicKeyJwk).toBe("string");
  });

  it("throws when the registration endpoint returns non-2xx", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(startKeyRotation()).rejects.toThrow("failed to register");
  });

  it("returns pending-retry and schedules a background retry when osn/api is unreachable in local dev", async () => {
    // Simulate a Bun ConnectionRefused: fetch() throws an Error with a `code` field.
    const netErr = Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(netErr)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );

    await expect(startKeyRotation()).resolves.toBe("pending-retry");
    expect(fetchSpy).toHaveBeenCalledOnce();

    // Advance past the retry delay (base 5s + up to 1s jitter).
    await vi.advanceTimersByTimeAsync(6_500);

    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Successful retry must not schedule another registration attempt.
    // Advancing a further minute should not invoke fetch again — the
    // next timer queued is the long-lived rotation timer (~22h out).
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("rethrows a network error in non-local environments (no background retry)", async () => {
    vi.stubEnv("OSN_ENV", "production");
    const netErr = Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(netErr);

    await expect(startKeyRotation()).rejects.toThrow("Unable to connect");
    expect(fetchSpy).toHaveBeenCalledOnce();

    // No retry scheduled: advancing time must not trigger more fetches.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("does NOT schedule a retry for errors with a non-network code (S-L1)", async () => {
    // An Error with a `code` field that isn't in the network-error allowlist
    // (e.g. a schema/parse error) must surface as a throw, not silently retry.
    const otherErr = Object.assign(new Error("bad parse"), { code: "ERR_INVALID_JSON" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(otherErr);

    await expect(startKeyRotation()).rejects.toThrow("bad parse");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("uses exponential backoff across successive retry failures (P-I1)", async () => {
    // Pin jitter to 0 so retry firing times are deterministic. The previous
    // bounds-based assertion was flaky: with jitter ∈ [-1s, +1s] attempt 1
    // fires in [4s, 6s] and attempt 2 schedules 10s±1s later, so attempt 2's
    // absolute firing window is [13s, 17s] — overlapping the t=15.5s probe.
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const netErr = Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(netErr);

    await expect(startKeyRotation()).resolves.toBe("pending-retry");
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // Attempt 1: schedules at exactly 5s (jitter pinned to 0).
    await vi.advanceTimersByTimeAsync(4_999);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Attempt 2: 10s after attempt 1 fires → absolute t=15s. Stop just short.
    await vi.advanceTimersByTimeAsync(9_997);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    // Cross the threshold.
    await vi.advanceTimersByTimeAsync(2);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });
});
