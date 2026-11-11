import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { createRecoveryClient, RecoveryError } from "../src/recovery";
import { authFetchSpy, expectAllThroughAuthFetch } from "./helpers/auth-fetch-spy";

const authFetch = authFetchSpy();

const config = { issuerUrl: "https://osn.example.com", authFetch };

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
    expectAllThroughAuthFetch(authFetch, "include", (url) =>
      /\/recovery\/(generate|status)$/.test(new URL(url).pathname),
    );
    vi.unstubAllGlobals();
  });

  describe("generateRecoveryCodes", () => {
    it("POSTs /recovery/generate through authFetch and returns the codes", async () => {
      const { calls } = stubFetch(() => jsonResponse({ recoveryCodes: sampleCodes }));
      const result = await client.generateRecoveryCodes({});

      expect(result.codes).toEqual(sampleCodes);
      expect(calls[0]!.url).toBe("https://osn.example.com/recovery/generate");
      expect(calls[0]!.init?.method).toBe("POST");
      const headers = new Headers(calls[0]!.init?.headers);
      expect(headers.get("authorization")).toBeNull();
      expect(headers.get("content-type")).toBe("application/json");
      expect(calls[0]!.init?.credentials).toBe("include");
    });

    it("throws RecoveryError on non-2xx", async () => {
      stubFetch(() => jsonResponse({ error: "unauthorized" }, { status: 401 }));
      await expect(client.generateRecoveryCodes({})).rejects.toBeInstanceOf(RecoveryError);
    });

    it("throws RecoveryError when the response body lacks a recoveryCodes array", async () => {
      stubFetch(() => jsonResponse({}, { status: 200 }));
      await expect(client.generateRecoveryCodes({})).rejects.toBeInstanceOf(RecoveryError);
    });

    it("strips a trailing slash from issuerUrl", async () => {
      const trailing = createRecoveryClient({ issuerUrl: "https://osn.example.com/", authFetch });
      const { calls } = stubFetch(() => jsonResponse({ recoveryCodes: sampleCodes }));
      await trailing.generateRecoveryCodes({});
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

  describe("emailRecoveryBegin", () => {
    const begun = {
      requestId: "recovery_0123456789ab",
      claimSecret: "c".repeat(64),
      pairingCode: "42",
      expiresAt: 1_800_000_000,
    };

    it("POSTs the identifier and resolves with the request on the uniform 202", async () => {
      const { calls } = stubFetch(() => jsonResponse(begun, { status: 202 }));
      await expect(client.emailRecoveryBegin({ identifier: "alice@example.com" })).resolves.toEqual(
        begun,
      );

      expect(calls[0]!.url).toBe("https://osn.example.com/login/recovery/email/begin");
      expect(calls[0]!.init?.method).toBe("POST");
      // `wiki/osn/sessions.md`: the issuer is a different origin from every
      // app that calls it, and a cross-origin fetch on the default
      // `same-origin` mode silently discards `Set-Cookie` — no error, no
      // warning, just no session. That is the bug class behind the 2026-08-06
      // registration fix, so it is asserted on every call in this module.
      expect(calls[0]!.init?.credentials).toBe("include");
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        identifier: "alice@example.com",
      });
    });

    it("throws RecoveryError on non-2xx", async () => {
      // 202 is the only success. A 400 is a refusal the server owes a reason
      // for — a handle where an address was required, a failed bot check — and
      // must not be swallowed as a request.
      stubFetch(() => jsonResponse({ error: "turnstile_failed" }, { status: 400 }));
      await expect(
        client.emailRecoveryBegin({ identifier: "alice@example.com" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });

    it("throws RecoveryError on a non-2xx with no JSON body", async () => {
      // A 429 from the edge carries no JSON. Parsing it unguarded would throw a
      // SyntaxError instead of the error type callers catch.
      stubFetch(() => new Response("too many requests", { status: 429 }));
      await expect(
        client.emailRecoveryBegin({ identifier: "alice@example.com" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });
  });

  describe("emailRecoveryStatus", () => {
    const input = { requestId: "recovery_0123456789ab", claimSecret: "c".repeat(64) };

    it("ends the wait only on a refusal, never on a transient", async () => {
      for (const status of [400, 404, 422]) {
        stubFetch(() => jsonResponse({ error: "invalid_request" }, { status }));
        // oxlint-disable-next-line no-await-in-loop -- one status after the other
        await expect(client.emailRecoveryStatus(input)).resolves.toEqual({ status: "expired" });
      }
      stubFetch(() => jsonResponse({ status: "expired" }));
      await expect(client.emailRecoveryStatus(input)).resolves.toEqual({ status: "expired" });
      for (const status of [429, 500, 503]) {
        stubFetch(() => jsonResponse({ error: "x" }, { status }));
        // oxlint-disable-next-line no-await-in-loop -- one status after the other
        await expect(client.emailRecoveryStatus(input)).rejects.toBeInstanceOf(RecoveryError);
      }
      vi.stubGlobal(
        "fetch",
        vi.fn(() => Promise.reject(new TypeError("network"))),
      );
      await expect(client.emailRecoveryStatus(input)).rejects.toMatchObject({
        name: "RecoveryError",
        status: 0,
      });
    });

    it("passes the number through, and parses the restricted session with its cookie", async () => {
      stubFetch(() => jsonResponse({ status: "pending", pairingCode: "42" }));
      await expect(client.emailRecoveryStatus(input)).resolves.toEqual({
        status: "pending",
        pairingCode: "42",
      });

      const { calls } = stubFetch(() =>
        jsonResponse(
          { status: "complete", session: sampleSessionPayload, profile: sampleProfile },
          { status: 201 },
        ),
      );
      const done = (await client.emailRecoveryStatus(input)) as {
        status: string;
        profile: unknown;
        session: { accessToken: string };
      };
      expect(done.status).toBe("complete");
      expect(done.profile).toEqual(sampleProfile);
      expect(done.session.accessToken).toBe("acc_abc");
      expect(calls[0]!.url).toBe(
        "https://osn.example.com/login/recovery/email/recovery_0123456789ab/status",
      );
      // The completing answer sets the refresh cookie.
      expect(calls[0]!.init?.credentials).toBe("include");
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        claimSecret: input.claimSecret,
      });
    });
  });

  /** The authenticator-code completer: a restricted session, or a refusal. */
  function completerCases(
    path: string,
    call: (input: { identifier: string; code: string }) => Promise<unknown>,
  ) {
    it("returns a parsed session + profile", async () => {
      const { calls } = stubFetch(() =>
        jsonResponse({ session: sampleSessionPayload, profile: sampleProfile }),
      );
      const result = (await call({ identifier: "alice@example.com", code: "123456" })) as {
        profile: unknown;
        session: { accessToken: string; expiresAt: number };
      };

      expect(result.profile).toEqual(sampleProfile);
      expect(result.session.accessToken).toBe("acc_abc");
      expect(result.session.expiresAt).toBeGreaterThan(Date.now());

      expect(calls[0]!.url).toBe(`https://osn.example.com${path}`);
      expect(calls[0]!.init?.method).toBe("POST");
      // This route sets the refresh cookie. See the note in
      // `emailRecoveryBegin` above.
      expect(calls[0]!.init?.credentials).toBe("include");
      expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
        identifier: "alice@example.com",
        code: "123456",
      });
    });

    it("throws RecoveryError on non-2xx", async () => {
      stubFetch(() => jsonResponse({ error: "invalid_request" }, { status: 400 }));
      await expect(
        call({ identifier: "nobody@example.com", code: "000000" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });

    it("throws RecoveryError when the response body is missing session", async () => {
      stubFetch(() => jsonResponse({ profile: sampleProfile }, { status: 200 }));
      await expect(
        call({ identifier: "alice@example.com", code: "123456" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });

    it("throws RecoveryError when the response body is missing profile", async () => {
      stubFetch(() => jsonResponse({ session: sampleSessionPayload }, { status: 200 }));
      await expect(
        call({ identifier: "alice@example.com", code: "123456" }),
      ).rejects.toBeInstanceOf(RecoveryError);
    });
  }

  describe("totpRecoveryComplete", () => {
    completerCases("/login/recovery/totp/complete", (input) => client.totpRecoveryComplete(input));
  });
});
