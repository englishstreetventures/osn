import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createPasskeysClient, PasskeysError } from "../src/passkeys";

/**
 * Wire-contract tests for `createPasskeysClient` (T-M2). Mirrors the
 * stubFetch harness used in `login.test.ts`. Catches silent drift on:
 *   • HTTP verb + path
 *   • Authorization header (and X-Step-Up-Token on delete)
 *   • `credentials: "include"` flag (HttpOnly session cookie)
 *   • request / response bodies
 *   • error shape propagation as PasskeysError
 *   • :id path encoding
 */

const config = { issuerUrl: "https://osn.example.com" };

interface FetchCall {
  url: string;
  init?: RequestInit;
}

function stubFetch(handler: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const call: FetchCall = { url, init };
    calls.push(call);
    return handler(call);
  });
  vi.stubGlobal("fetch", fn);
  return { calls, fn };
}

function jsonResponse(body: unknown, init: ResponseInit = { status: 200 }) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
  });
}

function headerMap(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (!h) return out;
  if (h instanceof Headers) {
    h.forEach((v, k) => (out[k.toLowerCase()] = v));
    return out;
  }
  if (Array.isArray(h)) {
    for (const [k, v] of h) out[k.toLowerCase()] = v;
    return out;
  }
  for (const [k, v] of Object.entries(h as Record<string, string>)) {
    out[k.toLowerCase()] = v;
  }
  return out;
}

const samplePasskey = {
  id: "pk_aaaaaaaaaaaa",
  label: "Work laptop",
  aaguid: null,
  transports: null,
  backupEligible: false,
  backupState: false,
  createdAt: 1_700_000_000,
  lastUsedAt: 1_700_005_000,
};

describe("createPasskeysClient", () => {
  let client: ReturnType<typeof createPasskeysClient>;

  beforeEach(() => {
    client = createPasskeysClient(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("list", () => {
    it("GETs /passkeys with Authorization bearer + credentials: include", async () => {
      const { calls } = stubFetch(() => jsonResponse({ passkeys: [samplePasskey] }));
      const result = await client.list({ accessToken: "acc_abc" });
      expect(result).toEqual({ passkeys: [samplePasskey] });
      expect(calls[0]!.url).toBe("https://osn.example.com/passkeys");
      expect(calls[0]!.init?.method).toBeUndefined();
      const h = headerMap(calls[0]!.init);
      expect(h["authorization"]).toBe("Bearer acc_abc");
      expect(calls[0]!.init?.credentials).toBe("include");
    });

    it("throws PasskeysError on non-2xx", async () => {
      stubFetch(() => jsonResponse({ error: "unauthorized" }, { status: 401 }));
      await expect(client.list({ accessToken: "x" })).rejects.toBeInstanceOf(PasskeysError);
    });

    it("throws PasskeysError when the body is missing the passkeys array", async () => {
      stubFetch(() => jsonResponse({ something: "else" }));
      await expect(client.list({ accessToken: "x" })).rejects.toBeInstanceOf(PasskeysError);
    });
  });

  describe("rename", () => {
    it("PATCHes /passkeys/:id with Authorization + X-Step-Up-Token + body { label }", async () => {
      const { calls } = stubFetch(() => jsonResponse({ success: true }));
      await client.rename({
        accessToken: "acc_abc",
        id: "pk_aaaaaaaaaaaa",
        label: "Primary",
        stepUpToken: "stpup_xyz",
      });
      expect(calls[0]!.url).toBe("https://osn.example.com/passkeys/pk_aaaaaaaaaaaa");
      expect(calls[0]!.init?.method).toBe("PATCH");
      const h = headerMap(calls[0]!.init);
      expect(h["authorization"]).toBe("Bearer acc_abc");
      expect(h["content-type"]).toBe("application/json");
      expect(h["x-step-up-token"]).toBe("stpup_xyz");
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({ label: "Primary" });
      expect(calls[0]!.init?.credentials).toBe("include");
    });

    it("encodes :id path segment", async () => {
      const { calls } = stubFetch(() => jsonResponse({ success: true }));
      await client.rename({
        accessToken: "t",
        id: "pk_ab+cd ef",
        label: "x",
        stepUpToken: "s",
      });
      expect(calls[0]!.url).toBe("https://osn.example.com/passkeys/pk_ab%2Bcd%20ef");
    });

    it("throws PasskeysError if the body does not confirm success", async () => {
      stubFetch(() => jsonResponse({ success: false, error: "Passkey not found" }));
      await expect(
        client.rename({ accessToken: "t", id: "pk_x", label: "y", stepUpToken: "s" }),
      ).rejects.toBeInstanceOf(PasskeysError);
    });
  });

  describe("delete", () => {
    it("DELETEs /passkeys/:id with Authorization + X-Step-Up-Token headers", async () => {
      const { calls } = stubFetch(() => jsonResponse({ success: true, remaining: 1 }));
      const result = await client.delete({
        accessToken: "acc_abc",
        id: "pk_aaaaaaaaaaaa",
        stepUpToken: "stpup_xyz",
      });
      expect(result).toEqual({ success: true, remaining: 1 });
      expect(calls[0]!.url).toBe("https://osn.example.com/passkeys/pk_aaaaaaaaaaaa");
      expect(calls[0]!.init?.method).toBe("DELETE");
      const h = headerMap(calls[0]!.init);
      expect(h["authorization"]).toBe("Bearer acc_abc");
      expect(h["x-step-up-token"]).toBe("stpup_xyz");
      expect(calls[0]!.init?.credentials).toBe("include");
    });

    it("defaults remaining to 0 when the server omits it but signals success", async () => {
      stubFetch(() => jsonResponse({ success: true }));
      const result = await client.delete({
        accessToken: "t",
        id: "pk_x",
        stepUpToken: "s",
      });
      expect(result).toEqual({ success: true, remaining: 0 });
    });

    it("throws PasskeysError on 403 (step-up missing server-side)", async () => {
      stubFetch(() => jsonResponse({ error: "step_up_required" }, { status: 403 }));
      await expect(
        client.delete({ accessToken: "t", id: "pk_x", stepUpToken: "s" }),
      ).rejects.toBeInstanceOf(PasskeysError);
    });
  });

  describe("registerBegin", () => {
    it("POSTs /passkey/register/begin with bearer + X-Step-Up-Token + body step_up_token + profileId", async () => {
      const options = { challenge: "chal_xyz" };
      const { calls } = stubFetch(() => jsonResponse(options));
      const result = await client.registerBegin({
        accessToken: "acc_abc",
        profileId: "prof_123",
        stepUpToken: "stpup_xyz",
      });
      expect(result).toEqual(options);
      expect(calls[0]!.url).toBe("https://osn.example.com/passkey/register/begin");
      expect(calls[0]!.init?.method).toBe("POST");
      const h = headerMap(calls[0]!.init);
      expect(h["authorization"]).toBe("Bearer acc_abc");
      expect(h["content-type"]).toBe("application/json");
      expect(h["x-step-up-token"]).toBe("stpup_xyz");
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        profileId: "prof_123",
        step_up_token: "stpup_xyz",
      });
      expect(calls[0]!.init?.credentials).toBe("include");
    });

    it("throws PasskeysError on 403 (step-up missing server-side)", async () => {
      stubFetch(() => jsonResponse({ error: "step_up_required" }, { status: 403 }));
      await expect(
        client.registerBegin({
          accessToken: "t",
          profileId: "prof",
          stepUpToken: "s",
        }),
      ).rejects.toBeInstanceOf(PasskeysError);
    });

    // T-U1: locks the pass-through contract — `registerBegin` does not
    // validate the WebAuthn options shape, it just forwards whatever the
    // server returns on 2xx. If we ever tighten that into a shape check
    // (e.g. require a `challenge` field), this test fails loudly and
    // forces the change to be intentional.
    it("passes an empty 2xx body through unchanged (pass-through contract)", async () => {
      stubFetch(() => jsonResponse({}));
      const result = await client.registerBegin({
        accessToken: "t",
        profileId: "prof",
        stepUpToken: "s",
      });
      expect(result).toEqual({});
    });
  });

  describe("registerComplete", () => {
    it("POSTs /passkey/register/complete with bearer and body { profileId, attestation }", async () => {
      const attestation = { id: "cred_abc" };
      const { calls } = stubFetch(() => jsonResponse({ passkeyId: "pk_new" }));
      const result = await client.registerComplete({
        accessToken: "acc_abc",
        profileId: "prof_123",
        attestation,
      });
      expect(result).toEqual({ passkeyId: "pk_new" });
      expect(calls[0]!.url).toBe("https://osn.example.com/passkey/register/complete");
      expect(calls[0]!.init?.method).toBe("POST");
      const h = headerMap(calls[0]!.init);
      expect(h["authorization"]).toBe("Bearer acc_abc");
      expect(h["content-type"]).toBe("application/json");
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        profileId: "prof_123",
        attestation,
      });
      expect(calls[0]!.init?.credentials).toBe("include");
    });

    it("throws PasskeysError when the body is missing passkeyId", async () => {
      stubFetch(() => jsonResponse({ error: "bad_attestation" }, { status: 400 }));
      await expect(
        client.registerComplete({
          accessToken: "t",
          profileId: "prof",
          attestation: {},
        }),
      ).rejects.toBeInstanceOf(PasskeysError);
    });

    // T-E1: the negative test above hits `!res.ok` before the missing-
    // passkeyId guard is even reached. Cover the guard directly: a 2xx
    // with a non-string `passkeyId` must still surface as PasskeysError.
    it("throws PasskeysError on 2xx when passkeyId is absent / wrong type", async () => {
      stubFetch(() => jsonResponse({ ok: true }, { status: 200 }));
      await expect(
        client.registerComplete({
          accessToken: "t",
          profileId: "prof",
          attestation: {},
        }),
      ).rejects.toBeInstanceOf(PasskeysError);
    });
  });
});
