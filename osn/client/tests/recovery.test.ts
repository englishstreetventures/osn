import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createRecoveryClient, RecoveryError } from "../src/recovery";

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

const sampleCodes = [
  "abcd-1234-5678-ef00",
  "1111-2222-3333-4444",
  "dead-beef-cafe-0000",
  "aaaa-bbbb-cccc-dddd",
  "0000-1111-2222-3333",
  "4444-5555-6666-7777",
  "8888-9999-aaaa-bbbb",
  "cccc-dddd-eeee-ffff",
  "0123-4567-89ab-cdef",
  "fedc-ba98-7654-3210",
];

const sampleSessionPayload = {
  access_token: "acc_abc",
  refresh_token: "ref_xyz",
  token_type: "Bearer",
  expires_in: 300,
};

const sampleProfile = {
  id: "usr_1",
  handle: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  avatarUrl: null,
};

describe("createRecoveryClient", () => {
  let client: ReturnType<typeof createRecoveryClient>;

  beforeEach(() => {
    client = createRecoveryClient(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("generateRecoveryCodes", () => {
    it("POSTs /recovery/generate with Bearer auth and returns the codes", async () => {
      const { calls } = stubFetch(() => jsonResponse({ recoveryCodes: sampleCodes }));
      const result = await client.generateRecoveryCodes({ accessToken: "acc_live" });

      expect(result.codes).toEqual(sampleCodes);
      expect(calls[0]!.url).toBe("https://osn.example.com/recovery/generate");
      expect(calls[0]!.init?.method).toBe("POST");
      const headers = new Headers(calls[0]!.init?.headers);
      expect(headers.get("authorization")).toBe("Bearer acc_live");
      expect(headers.get("content-type")).toBe("application/json");
      expect(calls[0]!.init?.credentials).toBe("include");
    });

    it("throws RecoveryError on non-2xx", async () => {
      stubFetch(() => jsonResponse({ error: "unauthorized" }, { status: 401 }));
      await expect(
        client.generateRecoveryCodes({ accessToken: "acc_live" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });

    it("throws RecoveryError when the response body lacks a recoveryCodes array", async () => {
      stubFetch(() => jsonResponse({}, { status: 200 }));
      await expect(
        client.generateRecoveryCodes({ accessToken: "acc_live" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });

    it("strips a trailing slash from issuerUrl", async () => {
      const trailing = createRecoveryClient({ issuerUrl: "https://osn.example.com/" });
      const { calls } = stubFetch(() => jsonResponse({ recoveryCodes: sampleCodes }));
      await trailing.generateRecoveryCodes({ accessToken: "acc_live" });
      expect(calls[0]!.url).toBe("https://osn.example.com/recovery/generate");
    });
  });

  describe("loginWithRecoveryCode", () => {
    it("returns a parsed session + profile", async () => {
      const { calls } = stubFetch(() =>
        jsonResponse({ session: sampleSessionPayload, profile: sampleProfile }),
      );
      const result = await client.loginWithRecoveryCode({
        identifier: "alice@example.com",
        code: "abcd-1234-5678-ef00",
      });

      expect(result.profile).toEqual(sampleProfile);
      expect(result.session.accessToken).toBe("acc_abc");
      // parseTokenResponse normalises expires_in → expiresAt (ms) on the client
      expect(result.session.expiresAt).toBeGreaterThan(Date.now());

      expect(calls[0]!.url).toBe("https://osn.example.com/login/recovery/complete");
      expect(calls[0]!.init?.method).toBe("POST");
      expect(calls[0]!.init?.credentials).toBe("include");
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        identifier: "alice@example.com",
        code: "abcd-1234-5678-ef00",
      });
    });

    it("throws RecoveryError on 400 without leaking the server error detail to caller as an instance", async () => {
      stubFetch(() => jsonResponse({ error: "invalid_request" }, { status: 400 }));
      await expect(
        client.loginWithRecoveryCode({ identifier: "nobody@x.com", code: "aaaa-bbbb-cccc-dddd" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });

    it("throws RecoveryError when the response body is missing session or profile", async () => {
      stubFetch(() => jsonResponse({ session: sampleSessionPayload }, { status: 200 }));
      await expect(
        client.loginWithRecoveryCode({ identifier: "x", code: "abcd-1234-5678-ef00" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });
  });
});
