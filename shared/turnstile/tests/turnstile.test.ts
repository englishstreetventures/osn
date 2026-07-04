import { describe, it, expect } from "vitest";

import { createTurnstileVerifier, siteverify, SITEVERIFY_URL, type FetchLike } from "../src/index";

/** Build a stub `fetch` that records its call and returns a canned response. */
function stubFetch(
  body: unknown,
  init: { ok?: boolean; status?: number } = {},
): { fetch: FetchLike; calls: Array<{ url: string; init?: RequestInit }> } {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl: FetchLike = async (url, reqInit) => {
    calls.push({ url: String(url), init: reqInit });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    } as Response;
  };
  return { fetch: fetchImpl, calls };
}

describe("createTurnstileVerifier — key-optional branch", () => {
  it("returns null when the secret is undefined (unconfigured → skip)", () => {
    expect(createTurnstileVerifier(undefined)).toBeNull();
  });

  it("returns null when the secret is empty or whitespace", () => {
    expect(createTurnstileVerifier("")).toBeNull();
    expect(createTurnstileVerifier("   ")).toBeNull();
  });

  it("returns a verifier when a real secret is present", () => {
    expect(createTurnstileVerifier("0xSECRET")).not.toBeNull();
  });
});

describe("verifier.verify — fail-closed semantics (configured)", () => {
  it("passes on a Cloudflare success:true response", async () => {
    const { fetch, calls } = stubFetch({ success: true });
    const verifier = createTurnstileVerifier("0xSECRET", fetch)!;
    const result = await verifier.verify("good-token", "203.0.113.7");
    expect(result.ok).toBe(true);
    expect(result.errorCodes).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(SITEVERIFY_URL);
  });

  it("rejects on success:false (invalid token)", async () => {
    const { fetch } = stubFetch({ success: false, "error-codes": ["invalid-input-response"] });
    const verifier = createTurnstileVerifier("0xSECRET", fetch)!;
    const result = await verifier.verify("bad-token");
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toEqual(["invalid-input-response"]);
  });

  it("rejects a duplicate (already-redeemed, single-use) token", async () => {
    const { fetch } = stubFetch({ success: false, "error-codes": ["timeout-or-duplicate"] });
    const verifier = createTurnstileVerifier("0xSECRET", fetch)!;
    const result = await verifier.verify("reused-token");
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toContain("timeout-or-duplicate");
  });

  it("rejects a missing/blank token WITHOUT a network call", async () => {
    const { fetch, calls } = stubFetch({ success: true });
    const verifier = createTurnstileVerifier("0xSECRET", fetch)!;
    expect((await verifier.verify(undefined)).ok).toBe(false);
    expect((await verifier.verify("")).ok).toBe(false);
    expect((await verifier.verify("   ")).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("fails closed when siteverify returns a non-2xx", async () => {
    const { fetch } = stubFetch({}, { ok: false, status: 502 });
    const verifier = createTurnstileVerifier("0xSECRET", fetch)!;
    const result = await verifier.verify("token");
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toEqual(["http-502"]);
  });

  it("fails closed (never throws) when fetch rejects", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const verifier = createTurnstileVerifier("0xSECRET", fetchImpl)!;
    const result = await verifier.verify("token");
    expect(result.ok).toBe(false);
    expect(result.errorCodes).toEqual(["siteverify-unreachable"]);
  });
});

describe("siteverify — wire format", () => {
  it("POSTs secret + response + remoteip as urlencoded form", async () => {
    const { fetch, calls } = stubFetch({ success: true });
    await siteverify("0xSECRET", "the-token", "203.0.113.7", fetch);
    const body = String(calls[0]!.init!.body);
    const params = new URLSearchParams(body);
    expect(params.get("secret")).toBe("0xSECRET");
    expect(params.get("response")).toBe("the-token");
    expect(params.get("remoteip")).toBe("203.0.113.7");
    expect(calls[0]!.init!.method).toBe("POST");
  });

  it("omits remoteip when not provided", async () => {
    const { fetch, calls } = stubFetch({ success: true });
    await siteverify("0xSECRET", "the-token", null, fetch);
    const params = new URLSearchParams(String(calls[0]!.init!.body));
    expect(params.has("remoteip")).toBe(false);
  });

  it("never embeds the secret in the URL (only the POST body)", async () => {
    const { fetch, calls } = stubFetch({ success: true });
    await siteverify("0xSECRET", "tok", "1.2.3.4", fetch);
    expect(calls[0]!.url).not.toContain("0xSECRET");
  });
});
