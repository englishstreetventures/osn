import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthFetchers, safeErrorMessage, safeJson } from "../src/auth-fetch";
import * as barrel from "../src/index";

class FakeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FakeError";
  }
}

const { authGet, authPost, authPatch, authDelete, authDeleteVoid } = createAuthFetchers(FakeError);

const url = "https://osn.example.com/thing";
const TOKEN = "test-token";

function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
}

function headersOf(call: Parameters<typeof fetch>) {
  return (call[1] as RequestInit).headers as Record<string, string>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createAuthFetchers — Authorization header", () => {
  it("authGet sends Bearer auth", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authGet(url, TOKEN);
    expect(headersOf(vi.mocked(fetch).mock.calls[0]!).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("authPost sends Bearer auth", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPost(url, TOKEN, { a: 1 });
    expect(headersOf(vi.mocked(fetch).mock.calls[0]!).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("authPatch sends Bearer auth", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPatch(url, TOKEN, { a: 1 });
    expect(headersOf(vi.mocked(fetch).mock.calls[0]!).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("authDelete sends Bearer auth", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authDelete(url, TOKEN);
    expect(headersOf(vi.mocked(fetch).mock.calls[0]!).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("authDeleteVoid sends Bearer auth", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve(null) });
    await authDeleteVoid(url, TOKEN);
    expect(headersOf(vi.mocked(fetch).mock.calls[0]!).Authorization).toBe(`Bearer ${TOKEN}`);
  });
});

describe("createAuthFetchers — Content-Type", () => {
  it("authPost sends application/json", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPost(url, TOKEN, { a: 1 });
    expect(headersOf(vi.mocked(fetch).mock.calls[0]!)["Content-Type"]).toBe("application/json");
  });

  it("authPatch sends application/json", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPatch(url, TOKEN, { a: 1 });
    expect(headersOf(vi.mocked(fetch).mock.calls[0]!)["Content-Type"]).toBe("application/json");
  });
});

describe("createAuthFetchers — authPost body handling", () => {
  it('sends body: undefined, not the string "undefined", when called with no body', async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPost(url, TOKEN);
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.body).toBeUndefined();
  });

  it("JSON-stringifies a provided body", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPost(url, TOKEN, { a: 1 });
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("createAuthFetchers — Invalid response on ok-but-unparseable body", () => {
  it("authGet throws Invalid response: <status>", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(authGet(url, TOKEN)).rejects.toThrow("Invalid response: 200");
  });

  it("authPost throws Invalid response: <status>", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(authPost(url, TOKEN, { a: 1 })).rejects.toThrow("Invalid response: 200");
  });

  it("authPatch throws Invalid response: <status>", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(authPatch(url, TOKEN, { a: 1 })).rejects.toThrow("Invalid response: 200");
  });

  it("authDelete throws Invalid response: <status>", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(authDelete(url, TOKEN)).rejects.toThrow("Invalid response: 200");
  });
});

describe("createAuthFetchers — authDeleteVoid", () => {
  it("resolves on an empty/unparseable success body", async () => {
    mockFetch({ ok: true, json: () => Promise.reject(new Error("bad json")) });
    await expect(authDeleteVoid(url, TOKEN)).resolves.toBeUndefined();
  });

  it("throws on non-2xx", async () => {
    mockFetch({ ok: false, json: () => Promise.resolve({ error: "boom" }) });
    await expect(authDeleteVoid(url, TOKEN)).rejects.toBeInstanceOf(FakeError);
  });
});

describe("safeErrorMessage", () => {
  it("falls back to Request failed: <status> on a missing key", async () => {
    expect(safeErrorMessage(undefined, 404)).toBe("Request failed: 404");
  });

  it("falls back to Request failed: <status> on an empty string", async () => {
    expect(safeErrorMessage("", 404)).toBe("Request failed: 404");
  });

  it("falls back to Request failed: <status> on a non-string value", async () => {
    expect(safeErrorMessage({ code: 1 }, 404)).toBe("Request failed: 404");
  });

  it("truncates a string longer than 200 characters to 200 chars + U+2026", async () => {
    const long = "x".repeat(250);
    const result = safeErrorMessage(long, 500);
    expect(result).toBe(`${"x".repeat(200)}…`);
    expect(result.length).toBe(201);
  });

  it("passes through a short string unchanged", async () => {
    expect(safeErrorMessage("boom", 400)).toBe("boom");
  });
});

describe("safeJson", () => {
  it("returns the parsed value for valid JSON", async () => {
    const res = { json: () => Promise.resolve({ a: 1 }) } as Response;
    await expect(safeJson(res)).resolves.toEqual({ a: 1 });
  });

  it("returns null when json() rejects", async () => {
    const res = { json: () => Promise.reject(new Error("bad json")) } as Response;
    await expect(safeJson(res)).resolves.toBeNull();
  });
});

describe("createAuthFetchers — signal forwarding", () => {
  it("authGet forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const controller = new AbortController();
    await authGet(url, TOKEN, { signal: controller.signal });
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("authPost forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const controller = new AbortController();
    await authPost(url, TOKEN, { a: 1 }, { signal: controller.signal });
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("authPatch forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const controller = new AbortController();
    await authPatch(url, TOKEN, { a: 1 }, { signal: controller.signal });
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("authDelete forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const controller = new AbortController();
    await authDelete(url, TOKEN, { signal: controller.signal });
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });

  it("authDeleteVoid forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve(null) });
    const controller = new AbortController();
    await authDeleteVoid(url, TOKEN, { signal: controller.signal });
    const init = vi.mocked(fetch).mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBe(controller.signal);
  });
});

describe("barrel", () => {
  it("does not re-export createAuthFetchers", () => {
    expect(Object.keys(barrel)).not.toContain("createAuthFetchers");
  });
});
