import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createLoginClient, LoginError } from "../src/login";

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

const sampleSessionPayload = {
  access_token: "acc_abc",
  refresh_token: "ref_xyz",
  token_type: "Bearer",
  expires_in: 3600,
};

const sampleProfile = {
  id: "usr_1",
  handle: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  avatarUrl: null,
};

describe("createLoginClient", () => {
  let client: ReturnType<typeof createLoginClient>;

  beforeEach(() => {
    client = createLoginClient(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("passkeyBegin", () => {
    it("POSTs /login/passkey/begin with the identifier", async () => {
      const { calls } = stubFetch(() => jsonResponse({ options: { challenge: "x" } }));
      const result = await client.passkeyBegin("alice");
      expect(result).toEqual({ options: { challenge: "x" } });
      expect(calls[0].url).toBe("https://osn.example.com/login/passkey/begin");
      expect(JSON.parse(calls[0].init!.body as string)).toEqual({ identifier: "alice" });
    });

    it("throws LoginError on non-2xx", async () => {
      stubFetch(() => jsonResponse({ error: "No passkeys" }, { status: 400 }));
      await expect(client.passkeyBegin("alice")).rejects.toBeInstanceOf(LoginError);
    });
  });

  describe("passkeyComplete", () => {
    it("returns a parsed session + profile", async () => {
      stubFetch(() => jsonResponse({ session: sampleSessionPayload, profile: sampleProfile }));
      const result = await client.passkeyComplete({
        identifier: "alice",
        assertion: { id: "cred" },
      });
      expect(result.profile).toEqual(sampleProfile);
      expect(result.session.accessToken).toBe("acc_abc");
      // Session no longer exposes refreshToken (Copenhagen Book C3).
      expect("refreshToken" in result.session).toBe(false);
    });
  });

  describe("surface", () => {
    it("only exposes passkey login methods", () => {
      expect(new Set(Object.keys(client))).toEqual(new Set(["passkeyBegin", "passkeyComplete"]));
    });
  });
});
