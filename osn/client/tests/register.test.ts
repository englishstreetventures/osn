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
  });

  describe("beginRegistration", () => {
    it("POSTs JSON to /register/begin with the right body", async () => {
      const { calls } = stubFetch(() => jsonResponse({ sent: true }));
      const result = await client.beginRegistration({
        email: "alice@example.com",
        handle: "alice",
        displayName: "Alice",
      });
      expect(result).toEqual({ sent: true });
      expect(calls[0].url).toBe("https://osn.example.com/register/begin");
      expect(calls[0].init?.method).toBe("POST");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({
        email: "alice@example.com",
        handle: "alice",
        displayName: "Alice",
      });
    });

    it("propagates the server error message", async () => {
      stubFetch(() => jsonResponse({ error: "Email already registered" }, { status: 400 }));
      await expect(
        client.beginRegistration({ email: "taken@example.com", handle: "taken" }),
      ).rejects.toThrow("Email already registered");
    });
  });

  describe("completeRegistration", () => {
    it("POSTs JSON to /register/complete and parses session + enrollment token", async () => {
      const { calls } = stubFetch(() =>
        jsonResponse(
          {
            userId: "usr_abc",
            handle: "alice",
            email: "alice@example.com",
            session: {
              access_token: "acc_999",
              refresh_token: "ref_999",
              token_type: "Bearer",
              expires_in: 3600,
              scope: "openid profile",
            },
            enrollment_token: "enroll_xyz",
          },
          { status: 201 },
        ),
      );
      const result = await client.completeRegistration({
        email: "alice@example.com",
        code: "123456",
      });
      expect(result.userId).toBe("usr_abc");
      expect(result.handle).toBe("alice");
      expect(result.email).toBe("alice@example.com");
      expect(result.enrollmentToken).toBe("enroll_xyz");

      // The session is parsed via the same parseTokenResponse used for the
      // OAuth callback flow.
      expect(result.session.accessToken).toBe("acc_999");
      expect(result.session.refreshToken).toBe("ref_999");
      expect(result.session.scopes).toEqual(["openid", "profile"]);
      expect(result.session.expiresAt).toBeGreaterThan(Date.now());

      expect(calls[0].url).toBe("https://osn.example.com/register/complete");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({
        email: "alice@example.com",
        code: "123456",
      });
    });

    it("throws RegistrationError on wrong OTP", async () => {
      stubFetch(() => jsonResponse({ error: "invalid_request" }, { status: 400 }));
      await expect(
        client.completeRegistration({ email: "alice@example.com", code: "000000" }),
      ).rejects.toThrow("invalid_request");
    });
  });

  describe("passkeyRegisterBegin / passkeyRegisterComplete (Authorization-gated)", () => {
    it("passkeyRegisterBegin sends Authorization: Bearer <enrollmentToken>", async () => {
      const options = { challenge: "ch_123", rp: { name: "OSN" } };
      const { calls } = stubFetch(() => jsonResponse(options));
      const result = await client.passkeyRegisterBegin({
        userId: "usr_abc",
        enrollmentToken: "enroll_xyz",
      });
      expect(result).toEqual(options);
      expect(calls[0].url).toBe("https://osn.example.com/passkey/register/begin");
      const headers = new Headers(calls[0].init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer enroll_xyz");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({ userId: "usr_abc" });
    });

    it("passkeyRegisterComplete sends Authorization header and userId+attestation body", async () => {
      const { calls } = stubFetch(() => jsonResponse({ passkeyId: "pk_xyz" }));
      const attestation = { id: "cred_id", rawId: "raw" };
      const result = await client.passkeyRegisterComplete({
        userId: "usr_abc",
        enrollmentToken: "enroll_xyz",
        attestation,
      });
      expect(result).toEqual({ passkeyId: "pk_xyz" });
      expect(calls[0].url).toBe("https://osn.example.com/passkey/register/complete");
      const headers = new Headers(calls[0].init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer enroll_xyz");
      expect(JSON.parse(calls[0].init?.body as string)).toEqual({
        userId: "usr_abc",
        attestation,
      });
    });

    it("propagates 401 from the server as a RegistrationError", async () => {
      stubFetch(() => jsonResponse({ error: "unauthorized" }, { status: 401 }));
      await expect(
        client.passkeyRegisterBegin({ userId: "usr_abc", enrollmentToken: "bad" }),
      ).rejects.toThrow("unauthorized");
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
