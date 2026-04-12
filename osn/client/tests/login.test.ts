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

const sampleUser = {
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
    it("returns a parsed session + user", async () => {
      stubFetch(() => jsonResponse({ session: sampleSessionPayload, user: sampleUser }));
      const result = await client.passkeyComplete("alice", { id: "cred" });
      expect(result.user).toEqual(sampleUser);
      expect(result.session.accessToken).toBe("acc_abc");
      expect(result.session.refreshToken).toBe("ref_xyz");
    });
  });

  describe("otpBegin", () => {
    it("POSTs /login/otp/begin and returns { sent: true }", async () => {
      const { calls } = stubFetch(() => jsonResponse({ sent: true }));
      const result = await client.otpBegin("alice@example.com");
      expect(result).toEqual({ sent: true });
      expect(calls[0].url).toBe("https://osn.example.com/login/otp/begin");
    });
  });

  describe("otpComplete", () => {
    it("returns a parsed session + user", async () => {
      stubFetch(() => jsonResponse({ session: sampleSessionPayload, user: sampleUser }));
      const result = await client.otpComplete("alice@example.com", "123456");
      expect(result.user).toEqual(sampleUser);
      expect(result.session.accessToken).toBe("acc_abc");
    });

    it("throws LoginError on invalid code", async () => {
      stubFetch(() => jsonResponse({ error: "Invalid request" }, { status: 400 }));
      await expect(client.otpComplete("alice@example.com", "000000")).rejects.toBeInstanceOf(
        LoginError,
      );
    });
  });

  describe("magicBegin", () => {
    it("POSTs /login/magic/begin and returns { sent: true }", async () => {
      const { calls } = stubFetch(() => jsonResponse({ sent: true }));
      await client.magicBegin("alice@example.com");
      expect(calls[0].url).toBe("https://osn.example.com/login/magic/begin");
      expect(JSON.parse(calls[0].init!.body as string)).toEqual({
        identifier: "alice@example.com",
      });
    });
  });

  describe("magicVerify", () => {
    it("GETs /login/magic/verify with url-encoded token", async () => {
      const { calls } = stubFetch(() =>
        jsonResponse({ session: sampleSessionPayload, user: sampleUser }),
      );
      const result = await client.magicVerify("mlnk_abc+def");
      expect(calls[0].url).toBe("https://osn.example.com/login/magic/verify?token=mlnk_abc%2Bdef");
      expect(result.user.handle).toBe("alice");
    });

    it("throws LoginError on bad token", async () => {
      stubFetch(() => jsonResponse({ error: "Magic link expired or not found" }, { status: 400 }));
      await expect(client.magicVerify("bogus")).rejects.toBeInstanceOf(LoginError);
    });
  });
});
