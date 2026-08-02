import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecommendationClient, RecommendationClientError } from "../src/recommendations";

const client = createRecommendationClient({ issuerUrl: "https://osn.example.com" });
const base = "https://osn.example.com/recommendations";
const TOKEN = "test-token";

function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRecommendationClient", () => {
  it("GETs /recommendations/connections with Bearer auth and no limit by default", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ suggestions: [] }) });
    await client.suggestConnections(TOKEN);
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/connections`);
    const headers = (call[1] as RequestInit).headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("appends ?limit when provided", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ suggestions: [] }) });
    await client.suggestConnections(TOKEN, { limit: 20 });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections?limit=20`);
  });

  it("returns the parsed suggestions list", async () => {
    const suggestions = [
      { handle: "alice", displayName: "Alice", avatarUrl: null, mutualCount: 3 },
    ];
    mockFetch({ ok: true, json: () => Promise.resolve({ suggestions }) });
    const result = await client.suggestConnections(TOKEN);
    expect(result.suggestions).toEqual(suggestions);
  });

  it("throws RecommendationClientError with server message on non-2xx", async () => {
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Too many requests" }) });
    await expect(client.suggestConnections(TOKEN)).rejects.toBeInstanceOf(
      RecommendationClientError,
    );
    await expect(client.suggestConnections(TOKEN)).rejects.toThrow("Too many requests");
  });

  it("surfaces RecommendationClientError (not SyntaxError) when error body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502,
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      }),
    );
    await expect(client.suggestConnections(TOKEN)).rejects.toBeInstanceOf(
      RecommendationClientError,
    );
  });

  it("strips trailing slash from issuerUrl", async () => {
    const trimmed = createRecommendationClient({ issuerUrl: "https://osn.example.com/" });
    mockFetch({ ok: true, json: () => Promise.resolve({ suggestions: [] }) });
    await trimmed.suggestConnections(TOKEN);
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections`);
  });

  describe("search", () => {
    it("GETs /recommendations/search with the query and Bearer auth", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      await client.search(TOKEN, "ali");
      const call = vi.mocked(fetch).mock.calls[0]!;
      expect(call[0]).toBe(`${base}/search?q=ali`);
      const headers = (call[1] as RequestInit).headers as Record<string, string>;
      expect(headers.Authorization).toBe(`Bearer ${TOKEN}`);
    });

    it("URL-encodes the query so a typed @ or & can't break out of the param", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      await client.search(TOKEN, "@ali&limit=99");
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/search?q=%40ali%26limit%3D99`);
    });

    it("appends ?limit when provided", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      await client.search(TOKEN, "ali", { limit: 5 });
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/search?q=ali&limit=5`);
    });

    it("forwards the abort signal so stale keystrokes can be cancelled", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      const controller = new AbortController();
      await client.search(TOKEN, "ali", { signal: controller.signal });
      const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBe(controller.signal);
    });

    it("appends ?orgLimit when provided", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      await client.search(TOKEN, "ali", { limit: 5, orgLimit: 2 });
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/search?q=ali&limit=5&orgLimit=2`);
    });

    it("returns both result sections", async () => {
      const people = [
        {
          handle: "alice",
          displayName: "Alice",
          avatarUrl: null,
          connectionStatus: "pending_sent",
        },
      ];
      const organisations = [
        { id: "org_1", handle: "acme", name: "Acme Inc", avatarUrl: null, isMember: false },
      ];
      mockFetch({ ok: true, json: () => Promise.resolve({ people, organisations }) });
      const result = await client.search(TOKEN, "ali");
      expect(result.people).toEqual(people);
      expect(result.organisations).toEqual(organisations);
    });

    it("throws RecommendationClientError on non-2xx", async () => {
      mockFetch({ ok: false, status: 429, json: () => Promise.resolve({ error: "Rate limited" }) });
      await expect(client.search(TOKEN, "ali")).rejects.toBeInstanceOf(RecommendationClientError);
    });
  });
});
