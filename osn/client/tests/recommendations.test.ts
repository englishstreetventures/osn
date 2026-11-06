import { afterEach, describe, expect, it, vi } from "vitest";

import { createRecommendationClient, RecommendationClientError } from "../src/recommendations";
import { authFetchSpy, expectAllThroughAuthFetch } from "./helpers/auth-fetch-spy";

const authFetch = authFetchSpy();

const client = createRecommendationClient({ issuerUrl: "https://osn.example.com", authFetch });
const base = "https://osn.example.com/recommendations";

function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

afterEach(() => {
  expectAllThroughAuthFetch(authFetch, "same-origin");
  vi.unstubAllGlobals();
});

describe("createRecommendationClient", () => {
  it("GETs /recommendations/connections through authFetch and no limit by default", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ suggestions: [] }) });
    await client.suggestConnections();
    const call = vi.mocked(fetch).mock.calls[0]!;
    expect(call[0]).toBe(`${base}/connections`);
    // `authFetch` supplies the token; the cookie stays home on these routes.
    expect(new Headers((call[1] as RequestInit).headers).get("authorization")).toBeNull();
    expect((call[1] as RequestInit).credentials).toBe("same-origin");
  });

  it("appends ?limit when provided", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ suggestions: [] }) });
    await client.suggestConnections({ limit: 20 });
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections?limit=20`);
  });

  it("throws RecommendationClientError with server message on non-2xx", async () => {
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "Too many requests" }) });
    await expect(client.suggestConnections()).rejects.toBeInstanceOf(RecommendationClientError);
    await expect(client.suggestConnections()).rejects.toThrow("Too many requests");
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
    await expect(client.suggestConnections()).rejects.toBeInstanceOf(RecommendationClientError);
  });

  it("strips trailing slash from issuerUrl", async () => {
    const trimmed = createRecommendationClient({
      issuerUrl: "https://osn.example.com/",
      authFetch,
    });
    mockFetch({ ok: true, json: () => Promise.resolve({ suggestions: [] }) });
    await trimmed.suggestConnections();
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/connections`);
  });

  describe("search", () => {
    it("GETs /recommendations/search with the query and Bearer auth", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      await client.search("ali");
      const call = vi.mocked(fetch).mock.calls[0]!;
      expect(call[0]).toBe(`${base}/search?q=ali`);
      expect(new Headers((call[1] as RequestInit).headers).get("authorization")).toBeNull();
      expect((call[1] as RequestInit).credentials).toBe("same-origin");
    });

    it("URL-encodes the query so a typed @ or & can't break out of the param", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      await client.search("@ali&limit=99");
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/search?q=%40ali%26limit%3D99`);
    });

    it("appends ?limit when provided", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      await client.search("ali", { limit: 5 });
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/search?q=ali&limit=5`);
    });

    it("forwards the abort signal so stale keystrokes can be cancelled", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      const controller = new AbortController();
      await client.search("ali", { signal: controller.signal });
      const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
      expect(init.signal).toBe(controller.signal);
    });

    it("appends ?orgLimit when provided", async () => {
      mockFetch({ ok: true, json: () => Promise.resolve({ people: [], organisations: [] }) });
      await client.search("ali", { limit: 5, orgLimit: 2 });
      expect(vi.mocked(fetch).mock.calls[0]![0]).toBe(`${base}/search?q=ali&limit=5&orgLimit=2`);
    });

    it("throws RecommendationClientError on non-2xx", async () => {
      mockFetch({ ok: false, status: 429, json: () => Promise.resolve({ error: "Rate limited" }) });
      await expect(client.search("ali")).rejects.toBeInstanceOf(RecommendationClientError);
    });
  });
});
