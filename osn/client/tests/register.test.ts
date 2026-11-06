import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createRegistrationClient, RegistrationError } from "../src/register";

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

describe("createRegistrationClient", () => {
  let client: ReturnType<typeof createRegistrationClient>;

  beforeEach(() => {
    client = createRegistrationClient(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("checkHandle", () => {
    it("GETs /handle/:handle and returns availability", async () => {
      const { calls } = stubFetch(() => jsonResponse({ available: true }));
      const result = await client.checkHandle("alice");
      expect(result).toEqual({ available: true });
      expect(calls[0].url).toBe("https://osn.example.com/handle/alice");
      expect(calls[0].init).toBeUndefined();
    });

    it("URL-encodes the handle path segment", async () => {
      const { calls } = stubFetch(() => jsonResponse({ available: false }));
      await client.checkHandle("weird name");
      expect(calls[0].url).toBe("https://osn.example.com/handle/weird%20name");
    });

    it("throws RegistrationError when the server replies with an error", async () => {
      stubFetch(() => jsonResponse({ error: "Invalid handle" }, { status: 400 }));
      await expect(client.checkHandle("Bad!")).rejects.toBeInstanceOf(RegistrationError);
      await expect(client.checkHandle("Bad!")).rejects.toThrow("Invalid handle");
    });

    it("throws RegistrationError when the response shape is unexpected", async () => {
      stubFetch(() => jsonResponse({ something: "else" }));
      await expect(client.checkHandle("alice")).rejects.toBeInstanceOf(RegistrationError);
    });

    it("threads an AbortSignal through to fetch (P-W10)", async () => {
      const { calls } = stubFetch(() => jsonResponse({ available: true }));
      const controller = new AbortController();
      await client.checkHandle("alice", controller.signal);
      expect(calls[0].init?.signal).toBe(controller.signal);
    });

    it("rejects with the abort reason when the signal is already aborted", async () => {
      // Mirror real fetch abort semantics: reject with the signal's reason.
      stubFetch((call) => {
        const signal = call.init?.signal;
        if (signal?.aborted) throw signal.reason;
        return jsonResponse({ available: true });
      });
      const controller = new AbortController();
      controller.abort();
      await expect(client.checkHandle("alice", controller.signal)).rejects.toMatchObject({
        name: "AbortError",
      });
    });
  });

  describe("beginRegistration", () => {
    it("POSTs JSON to /register/begin and answers the request the tab now holds", async () => {
      const begun = {
        requestId: "signup_0123456789ab",
        claimSecret: "c".repeat(64),
        pairingCode: "47",
        expiresAt: 1_900_000_000,
      };
      const { calls } = stubFetch(() => jsonResponse(begun));
      const result = await client.beginRegistration({
        email: "alice@example.com",
        handle: "alice",
        birthdate: "1990-01-01",
        displayName: "Alice",
        previous: { requestId: "signup_aaaaaaaaaaaa", claimSecret: "d".repeat(64) },
      });
      expect(result).toEqual(begun);
      expect(calls[0].url).toBe("https://osn.example.com/register/begin");
      expect(calls[0].init?.method).toBe("POST");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({
        email: "alice@example.com",
        handle: "alice",
        birthdate: "1990-01-01",
        displayName: "Alice",
        previous: { requestId: "signup_aaaaaaaaaaaa", claimSecret: "d".repeat(64) },
      });
    });

    it("propagates the server error message", async () => {
      stubFetch(() => jsonResponse({ error: "age_restricted" }, { status: 422 }));
      await expect(
        client.beginRegistration({
          email: "kid@example.com",
          handle: "kid",
          birthdate: "2020-01-01",
        }),
      ).rejects.toThrow("age_restricted");
    });
  });

  describe("registrationStatus", () => {
    const ids = { requestId: "signup_0123456789ab", claimSecret: "c".repeat(64) };
    const complete = {
      status: "complete",
      profileId: "usr_abc",
      handle: "alice",
      email: "alice@example.com",
      session: {
        access_token: "acc_999",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid profile",
      },
    };

    it("parses the completing answer's session", async () => {
      const { calls } = stubFetch(() => jsonResponse(complete, { status: 201 }));
      const result = await client.registrationStatus(ids);
      expect(result.status).toBe("complete");
      if (result.status !== "complete") return;
      expect(result.profileId).toBe("usr_abc");
      expect(result.handle).toBe("alice");
      expect(result.email).toBe("alice@example.com");
      expect(result.session.accessToken).toBe("acc_999");
      expect("refreshToken" in result.session).toBe(false);
      expect(result.session.scopes).toEqual(["openid", "profile"]);
      expect(calls[0].url).toBe("https://osn.example.com/register/signup_0123456789ab/status");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({ claimSecret: "c".repeat(64) });
    });

    it("passes pending, expired and conflict through", async () => {
      for (const status of ["pending", "expired", "conflict"]) {
        stubFetch(() => jsonResponse({ status }));
        // oxlint-disable-next-line no-await-in-loop -- one stub at a time
        expect(await client.registrationStatus(ids)).toEqual({ status });
      }
    });

    it("reads a refusal as expired, so a dead request ends the wait", async () => {
      for (const status of [400, 404, 422]) {
        stubFetch(() => jsonResponse({ error: "invalid_request" }, { status }));
        // oxlint-disable-next-line no-await-in-loop -- one stub at a time
        expect(await client.registrationStatus(ids)).toEqual({ status: "expired" });
      }
    });

    it("throws on a rate limit, a server error or no answer, so the wait goes on", async () => {
      for (const status of [429, 500, 503]) {
        stubFetch(() => jsonResponse({ error: "x" }, { status }));
        // oxlint-disable-next-line no-await-in-loop -- one stub at a time
        await expect(client.registrationStatus(ids)).rejects.toBeInstanceOf(RegistrationError);
      }
      stubFetch(() => Promise.reject(new TypeError("Failed to fetch")));
      await expect(client.registrationStatus(ids)).rejects.toThrow("Failed to fetch");
    });

    /**
     * The refresh token exists ONLY as the `Set-Cookie` on the completing
     * answer. The issuer is a different origin from every app that calls it,
     * and a cross-origin fetch on the default `same-origin` credentials mode
     * discards `Set-Cookie` outright, so without this the new account would
     * end with an in-memory access token and no session.
     */
    it("sends credentials so the refresh cookie survives the cross-origin hop", async () => {
      const { calls } = stubFetch(() => jsonResponse(complete, { status: 201 }));
      await client.registrationStatus(ids);
      expect(calls[0].init?.credentials).toBe("include");
    });
  });

  describe("resendRegistrationLink", () => {
    it("POSTs the claim secret and answers the status", async () => {
      const { calls } = stubFetch(() => jsonResponse({ status: "limit" }));
      const result = await client.resendRegistrationLink({
        requestId: "signup_0123456789ab",
        claimSecret: "c".repeat(64),
      });
      expect(result).toEqual({ status: "limit" });
      expect(calls[0].url).toBe("https://osn.example.com/register/signup_0123456789ab/resend");
    });
  });

  describe("passkeyRegisterBegin / passkeyRegisterComplete (access-token-gated)", () => {
    it("passkeyRegisterBegin sends Authorization: Bearer <accessToken>", async () => {
      const options = { challenge: "ch_123", rp: { name: "Musubi" } };
      const { calls } = stubFetch(() => jsonResponse(options));
      const result = await client.passkeyRegisterBegin({
        profileId: "usr_abc",
        accessToken: "acc_999",
      });
      expect(result).toEqual(options);
      expect(calls[0].url).toBe("https://osn.example.com/passkey/register/begin");
      const headers = new Headers(calls[0].init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer acc_999");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({ profileId: "usr_abc" });
    });

    it("passkeyRegisterComplete sends access token + profileId+attestation", async () => {
      const { calls } = stubFetch(() => jsonResponse({ passkeyId: "pk_xyz" }));
      const attestation = { id: "cred_id", rawId: "raw" };
      const result = await client.passkeyRegisterComplete({
        profileId: "usr_abc",
        accessToken: "acc_999",
        attestation,
      });
      expect(result).toEqual({ passkeyId: "pk_xyz" });
      expect(calls[0].url).toBe("https://osn.example.com/passkey/register/complete");
      const headers = new Headers(calls[0].init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer acc_999");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({
        profileId: "usr_abc",
        attestation,
      });
    });

    it("propagates 401 from the server as a RegistrationError", async () => {
      stubFetch(() => jsonResponse({ error: "unauthorized" }, { status: 401 }));
      await expect(
        client.passkeyRegisterBegin({ profileId: "usr_abc", accessToken: "bad" }),
      ).rejects.toThrow("unauthorized");
    });

    /**
     * T-U1. Enrollment shares `postJson` with registration, so it inherits
     * `credentials: "include"` — and it needs it for its own reason. The bearer
     * token names the *account*; the cookie names *which session is the
     * caller's own*, which is how `/passkey/register/complete` knows to spare
     * that one when it revokes the rest (S-H1). Without the cookie the server
     * falls back to the access token's `osn_sid` binding rather than failing,
     * so a regression here is silent — no test elsewhere would go red. Pinning
     * it at both cookie-dependent routes makes the header a property of the
     * transport instead of one test's happy path.
     */
    it("sends credentials on both enrollment legs, not just registration", async () => {
      const begin = stubFetch(() => jsonResponse({ challenge: "ch_123" }));
      await client.passkeyRegisterBegin({ profileId: "usr_abc", accessToken: "acc_999" });
      expect(begin.calls[0].init?.credentials).toBe("include");

      const complete = stubFetch(() => jsonResponse({ passkeyId: "pk_xyz" }));
      await client.passkeyRegisterComplete({
        profileId: "usr_abc",
        accessToken: "acc_999",
        attestation: { id: "cred_id" },
      });
      expect(complete.calls[0].init?.credentials).toBe("include");
    });
  });

  it("strips a trailing slash from issuerUrl", async () => {
    const c = createRegistrationClient({
      issuerUrl: "https://osn.example.com/",
    });
    const { calls } = stubFetch(() => jsonResponse({ available: true }));
    await c.checkHandle("alice");
    expect(calls[0].url).toBe("https://osn.example.com/handle/alice");
  });
});
