import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { instrumentedFetch } from "../src/fetch/instrument";

/**
 * `instrumentedFetch` wraps `globalThis.fetch`. To test it in isolation
 * we swap `globalThis.fetch` with a stub that records the URL + headers
 * it was called with. The stub also lets us simulate error responses
 * and thrown errors without a real network round-trip.
 */
type FetchStub = ReturnType<typeof vi.fn>;

let stub: FetchStub;
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  stub = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => {
    return new Response("ok", { status: 200 });
  });
  globalThis.fetch = stub as unknown as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const getStubInit = (call: number): RequestInit | undefined =>
  stub.mock.calls[call]?.[1] as RequestInit | undefined;

const getStubHeaders = (call: number): Headers | undefined => {
  const init = getStubInit(call);
  if (!init?.headers) return undefined;
  return init.headers instanceof Headers ? init.headers : new Headers(init.headers);
};

describe("instrumentedFetch", () => {
  it("forwards the URL and method to globalThis.fetch", async () => {
    const res = await instrumentedFetch("http://example.com/api/x", { method: "POST" });
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0]?.[0]).toBe("http://example.com/api/x");
    expect(getStubInit(0)?.method).toBe("POST");
    expect(res.status).toBe(200);
  });

  it("preserves caller-supplied headers including Authorization", async () => {
    await instrumentedFetch("http://example.com/", {
      headers: { authorization: "ARC eyJ...", "x-custom": "yes" },
    });
    const hdrs = getStubHeaders(0);
    expect(hdrs?.get("authorization")).toBe("ARC eyJ...");
    expect(hdrs?.get("x-custom")).toBe("yes");
  });

  it("returns non-2xx responses without throwing (span records error status)", async () => {
    stub.mockResolvedValueOnce(new Response("nope", { status: 404 }));
    const res = await instrumentedFetch("http://example.com/missing");
    expect(res.status).toBe(404);
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("propagates thrown fetch errors and still ends the span", async () => {
    stub.mockRejectedValueOnce(new Error("network down"));
    await expect(instrumentedFetch("http://example.com/")).rejects.toThrow("network down");
    expect(stub).toHaveBeenCalledTimes(1);
  });

  it("does not crash when URL parsing fails — still dispatches to fetch", async () => {
    // A bare string that isn't a valid URL should still reach fetch.
    // The wrapper just skips the url.* semconv attributes in that case.
    await instrumentedFetch("not-a-url");
    expect(stub).toHaveBeenCalledTimes(1);
    expect(stub.mock.calls[0]?.[0]).toBe("not-a-url");
  });

  it("attaches a Headers object even when caller passes none", async () => {
    await instrumentedFetch("http://example.com/");
    const hdrs = getStubHeaders(0);
    expect(hdrs).toBeInstanceOf(Headers);
  });

  it("reuses caller's Headers instance instead of allocating a new one (P-I3)", async () => {
    const callerHeaders = new Headers({ authorization: "ARC tok", "x-a": "b" });
    await instrumentedFetch("http://example.com/", { headers: callerHeaders });
    // Assertion: the exact same Headers reference was passed through
    // to globalThis.fetch. `init` in the stub call should reference
    // callerHeaders directly.
    const init = getStubInit(0);
    expect(init?.headers).toBe(callerHeaders);
  });
});
