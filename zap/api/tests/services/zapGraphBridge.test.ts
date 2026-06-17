import { Effect } from "effect";
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock @shared/crypto so key generation never hits the real Web Crypto API
// (generateArcKeyPair is slow in the test env). Mirrors the pulse graphBridge
// test setup.
vi.mock("@shared/crypto", () => ({
  generateArcKeyPair: vi.fn().mockResolvedValue({
    privateKey: {} as CryptoKey,
    publicKey: {} as CryptoKey,
  }),
  exportKeyToJwk: vi.fn().mockResolvedValue('{"kty":"EC","crv":"P-256","x":"stub","y":"stub"}'),
  getOrCreateArcToken: vi.fn().mockResolvedValue("test-arc-token"),
}));

import { areConnected, GraphBridgeError } from "../../src/services/zapGraphBridge";

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

describe("areConnected", () => {
  it("returns true without a network call for a self-pair", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const result = await Effect.runPromise(areConnected("usr_alice", "usr_alice"));
    expect(result).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it("returns true when the graph reports status connected", async () => {
    mockFetch({ status: "connected" });
    const result = await Effect.runPromise(areConnected("usr_alice", "usr_bob"));
    expect(result).toBe(true);
  });

  it("returns false for any non-connected status", async () => {
    mockFetch({ status: "pending_sent" });
    const result = await Effect.runPromise(areConnected("usr_alice", "usr_bob"));
    expect(result).toBe(false);
  });

  it("calls /graph/internal/connection-status with viewerId + targetId and an ARC header", async () => {
    const spy = mockFetch({ status: "none" });
    await Effect.runPromise(areConnected("usr_alice", "usr_bob"));
    const [url, init] = spy.mock.calls[0]!;
    expect(url).toContain("/graph/internal/connection-status");
    const search = new URLSearchParams((url as string).split("?")[1]);
    expect(search.get("viewerId")).toBe("usr_alice");
    expect(search.get("targetId")).toBe("usr_bob");
    const headers = init?.headers as Record<string, string>;
    expect(headers["authorization"]).toMatch(/^ARC /);
  });

  it("fails with GraphBridgeError on HTTP error (callers fail closed)", async () => {
    mockFetch({ error: "Unauthorized" }, 401);
    const err = await Effect.runPromise(Effect.flip(areConnected("usr_alice", "usr_bob")));
    expect(err).toBeInstanceOf(GraphBridgeError);
  });
});
