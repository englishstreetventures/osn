import { afterEach, describe, expect, it, vi } from "vitest";

import { createGraphClient, GraphClientError } from "../src/graph";

const client = createGraphClient({ issuerUrl: "https://osn.example.com" });
const base = "https://osn.example.com/graph";
const TOKEN = "test-token";

function mockFetch(response: { ok: boolean; json: () => Promise<unknown> }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

function expectAuthHeader(call: Parameters<typeof fetch>) {
  const init = call[1] as RequestInit;
  const headers = init.headers as Record<string, string>;
  expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createGraphClient — listConnections", () => {
  it("GETs /graph/connections with Bearer auth", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ connections: [] }) });
    await client.listConnections(TOKEN);
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/connections`);
    expect((call[1] as RequestInit).method).toBeUndefined(); // fetch defaults to GET
    expectAuthHeader(call);
  });

  it("serialises limit/offset as query params", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ connections: [] }) });
    await client.listConnections(TOKEN, { limit: 20, offset: 40 });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections?limit=20&offset=40`);
  });

  it("throws GraphClientError on non-2xx", async () => {
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "boom" }) });
    await expect(client.listConnections(TOKEN)).rejects.toBeInstanceOf(GraphClientError);
  });
});

describe("createGraphClient — listPendingRequests / listCloseFriends / listBlocks", () => {
  it("hits the correct paths", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ pending: [] }) });
    await client.listPendingRequests(TOKEN);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections/pending`);

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ closeFriends: [] }),
    } as Response);
    await client.listCloseFriends(TOKEN);
    expect(vi.mocked(fetch).mock.calls[1]![0]).toBe(`${base}/close-friends`);

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ blocks: [] }),
    } as Response);
    await client.listBlocks(TOKEN);
    expect(vi.mocked(fetch).mock.calls[2]![0]).toBe(`${base}/blocks`);
  });
});

describe("createGraphClient — connection mutations", () => {
  it("getConnectionStatus GETs /graph/connections/:handle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ status: "connected" }) });
    const result = await client.getConnectionStatus(TOKEN, "alice");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections/alice`);
    expect(result.status).toBe("connected");
  });

  it("sendConnectionRequest POSTs /graph/connections/:handle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.sendConnectionRequest(TOKEN, "alice");
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/connections/alice`);
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("acceptConnection PATCHes with action=accept", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.acceptConnection(TOKEN, "alice");
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect((call[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({ action: "accept" });
  });

  it("rejectConnection PATCHes with action=reject", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.rejectConnection(TOKEN, "alice");
    expect(JSON.parse((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).body as string)).toEqual({
      action: "reject",
    });
  });

  it("removeConnection DELETEs /graph/connections/:handle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.removeConnection(TOKEN, "alice");
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("URL-encodes handles with special chars", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.sendConnectionRequest(TOKEN, "alice bob");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections/alice%20bob`);
  });
});

describe("createGraphClient — close friends & blocks", () => {
  it("addCloseFriend POSTs /graph/close-friends/:handle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.addCloseFriend(TOKEN, "alice");
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/close-friends/alice`);
    expect((call[1] as RequestInit).method).toBe("POST");
  });

  it("removeCloseFriend DELETEs /graph/close-friends/:handle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.removeCloseFriend(TOKEN, "alice");
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });

  it("blockProfile POSTs /graph/blocks/:handle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.blockProfile(TOKEN, "alice");
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/blocks/alice`);
  });

  it("unblockProfile DELETEs /graph/blocks/:handle", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await client.unblockProfile(TOKEN, "alice");
    expect((vi.mocked(fetch).mock.calls[0]![1] as RequestInit).method).toBe("DELETE");
  });
});

describe("createGraphClient — error surface", () => {
  it("surfaces server-supplied error messages", async () => {
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Already connected" }) });
    await expect(client.sendConnectionRequest(TOKEN, "alice")).rejects.toThrow("Already connected");
  });

  it("falls back to a generic message when the server omits one", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: () => Promise.resolve({}),
      }),
    );
    await expect(client.sendConnectionRequest(TOKEN, "alice")).rejects.toThrow(/Request failed/);
  });

  it("throws GraphClientError (not SyntaxError) when the error body is not JSON (S-L2)", async () => {
    // E.g. a proxy returns an HTML error page. The client must not leak
    // the SyntaxError from res.json() to the caller.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      }),
    );
    await expect(client.sendConnectionRequest(TOKEN, "alice")).rejects.toBeInstanceOf(
      GraphClientError,
    );
  });

  it("throws GraphClientError when a 200 response body is not JSON (S-L2)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      }),
    );
    await expect(client.listConnections(TOKEN)).rejects.toBeInstanceOf(GraphClientError);
  });

  it("truncates long error strings (S-L2)", async () => {
    const long = "x".repeat(500);
    mockFetch({ ok: false, json: () => Promise.resolve({ error: long }) });
    await expect(client.sendConnectionRequest(TOKEN, "alice")).rejects.toThrow(/^x{200}…$/);
  });
});

describe("createGraphClient — configuration", () => {
  it("strips a trailing slash from issuerUrl", async () => {
    const trimmed = createGraphClient({ issuerUrl: "https://osn.example.com/" });
    mockFetch({ ok: true, json: () => Promise.resolve({ connections: [] }) });
    await trimmed.listConnections(TOKEN);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections`);
  });
});
