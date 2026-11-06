import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthFetchers, safeErrorMessage, safeJson } from "../src/auth-fetch";
import type { AuthFetch } from "../src/runtime";

class FakeError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "FakeError";
    this.status = status;
  }
}

const authFetch = vi.fn<AuthFetch>();
const { authGet, authPost, authPatch, authDelete, authDeleteVoid } = createAuthFetchers(
  FakeError,
  authFetch,
);

const url = "https://osn.example.com/thing";

function mockFetch(response: { ok: boolean; status?: number; json: () => Promise<unknown> }) {
  authFetch.mockResolvedValue(response as Response);
}

function initOf(index = 0): RequestInit {
  return authFetch.mock.calls[index]![1]!;
}

function headersOf(index = 0) {
  return (initOf(index).headers ?? {}) as Record<string, string>;
}

afterEach(() => {
  authFetch.mockReset();
});

const ALL = [
  ["authGet", () => authGet(url)],
  ["authPost", () => authPost(url, { a: 1 })],
  ["authPatch", () => authPatch(url, { a: 1 })],
  ["authDelete", () => authDelete(url)],
  ["authDeleteVoid", () => authDeleteVoid(url)],
] as const;

describe("createAuthFetchers — sends through authFetch", () => {
  it.each(ALL)(
    "%s sets no Authorization of its own and keeps the cookie at home",
    async (_n, run) => {
      mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
      await run();
      expect(authFetch).toHaveBeenCalledTimes(1);
      expect(authFetch.mock.calls[0]![0]).toBe(url);
      expect(headersOf()).not.toHaveProperty("Authorization");
      // These routes read no cookie; `authFetch` would otherwise default to "include".
      expect(initOf().credentials).toBe("same-origin");
    },
  );

  it.each(ALL)("%s passes an authFetch rejection through unchanged", async (_n, run) => {
    const ended = new Error("session ended");
    authFetch.mockRejectedValue(ended);
    await expect(run()).rejects.toBe(ended);
  });
});

describe("createAuthFetchers — Content-Type", () => {
  it("authPost sends application/json", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPost(url, { a: 1 });
    expect(headersOf()["Content-Type"]).toBe("application/json");
  });

  it("authPatch sends application/json", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPatch(url, { a: 1 });
    expect(headersOf()["Content-Type"]).toBe("application/json");
  });
});

describe("createAuthFetchers — authPost body handling", () => {
  it('sends body: undefined, not the string "undefined", when called with no body', async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPost(url);
    const init = initOf();
    expect(init.body).toBeUndefined();
  });

  it("JSON-stringifies a provided body", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    await authPost(url, { a: 1 });
    const init = initOf();
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });
});

describe("createAuthFetchers — Invalid response on ok-but-unparseable body", () => {
  it("authGet throws Invalid response: <status>, carrying the status", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(authGet(url)).rejects.toMatchObject({
      name: "FakeError",
      message: "Invalid response: 200",
      status: 200,
    });
  });

  it("authPost throws Invalid response: <status>, carrying the status", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(authPost(url, { a: 1 })).rejects.toMatchObject({
      name: "FakeError",
      message: "Invalid response: 200",
      status: 200,
    });
  });

  it("authPatch throws Invalid response: <status>, carrying the status", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(authPatch(url, { a: 1 })).rejects.toMatchObject({
      name: "FakeError",
      message: "Invalid response: 200",
      status: 200,
    });
  });

  it("authDelete throws Invalid response: <status>, carrying the status", async () => {
    mockFetch({ ok: true, status: 200, json: () => Promise.reject(new Error("bad json")) });
    await expect(authDelete(url)).rejects.toMatchObject({
      name: "FakeError",
      message: "Invalid response: 200",
      status: 200,
    });
  });
});

describe("createAuthFetchers — authDeleteVoid", () => {
  it("resolves on an empty/unparseable success body", async () => {
    mockFetch({ ok: true, json: () => Promise.reject(new Error("bad json")) });
    await expect(authDeleteVoid(url)).resolves.toBeUndefined();
  });

  it("throws on non-2xx", async () => {
    mockFetch({ ok: false, status: 403, json: () => Promise.resolve({ error: "boom" }) });
    await expect(authDeleteVoid(url)).rejects.toBeInstanceOf(FakeError);
  });
});

describe("createAuthFetchers — a failed response's status reaches the error", () => {
  it.each([
    ["authGet", () => authGet(url)],
    ["authPost", () => authPost(url, { a: 1 })],
    ["authPatch", () => authPatch(url, { a: 1 })],
    ["authDelete", () => authDelete(url)],
    ["authDeleteVoid", () => authDeleteVoid(url)],
  ] as const)("%s throws with the message and the status", async (_name, run) => {
    mockFetch({ ok: false, status: 403, json: () => Promise.resolve({ error: "boom" }) });
    await expect(run()).rejects.toMatchObject({ name: "FakeError", message: "boom", status: 403 });
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
  it("returns null when json() rejects", async () => {
    const res = { json: () => Promise.reject(new Error("bad json")) } as Response;
    await expect(safeJson(res)).resolves.toBeNull();
  });
});

describe("createAuthFetchers — signal forwarding", () => {
  it("authGet forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const controller = new AbortController();
    await authGet(url, { signal: controller.signal });
    const init = initOf();
    expect(init.signal).toBe(controller.signal);
  });

  it("authPost forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const controller = new AbortController();
    await authPost(url, { a: 1 }, { signal: controller.signal });
    const init = initOf();
    expect(init.signal).toBe(controller.signal);
  });

  it("authPatch forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const controller = new AbortController();
    await authPatch(url, { a: 1 }, { signal: controller.signal });
    const init = initOf();
    expect(init.signal).toBe(controller.signal);
  });

  it("authDelete forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve({ ok: true }) });
    const controller = new AbortController();
    await authDelete(url, { signal: controller.signal });
    const init = initOf();
    expect(init.signal).toBe(controller.signal);
  });

  it("authDeleteVoid forwards the abort signal", async () => {
    mockFetch({ ok: true, json: () => Promise.resolve(null) });
    const controller = new AbortController();
    await authDeleteVoid(url, { signal: controller.signal });
    const init = initOf();
    expect(init.signal).toBe(controller.signal);
  });
});
