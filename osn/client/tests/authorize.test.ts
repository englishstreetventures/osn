import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { AuthorizeError, createAuthorizeClient } from "../src/authorize";

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

const requestId = "oar_0123456789ab";

const sampleProfile = {
  id: "usr_1",
  handle: "alice",
  email: "alice@example.com",
  displayName: "Alice",
  avatarUrl: null,
};

const sampleContext = {
  client: {
    clientId: "cli_abc",
    name: "Cire",
    logoUrl: "https://cdn.example.com/logo.png",
    firstParty: false,
  },
  scopes: ["openid", "profile", "email"],
  signedIn: true,
  profiles: [sampleProfile],
  linkedProfileId: null,
};

describe("createAuthorizeClient", () => {
  let client: ReturnType<typeof createAuthorizeClient>;

  beforeEach(() => {
    client = createAuthorizeClient(config);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  describe("getContext", () => {
    it("sends a credentialed GET carrying the request id", async () => {
      const { calls } = stubFetch(() => jsonResponse(sampleContext));

      const context = await client.getContext(requestId);

      expect(calls[0]?.url).toBe(`https://osn.example.com/authorize/context?request=${requestId}`);
      expect(calls[0]?.init?.method).toBe("GET");
      // The binding cookie is the security model — it only rides on credentialed calls.
      expect(calls[0]?.init?.credentials).toBe("include");
      expect(context.client.name).toBe("Cire");
      expect(context.scopes).toEqual(["openid", "profile", "email"]);
      expect(context.profiles).toHaveLength(1);
      expect(context.linkedProfileId).toBeNull();
    });

    it("trims a trailing slash off the issuer URL", async () => {
      const { calls } = stubFetch(() => jsonResponse(sampleContext));

      await createAuthorizeClient({ issuerUrl: "https://osn.example.com/" }).getContext(requestId);

      expect(calls[0]?.url.startsWith("https://osn.example.com/authorize/context")).toBe(true);
    });

    it("maps a 404 to a terminal invalid_request error", async () => {
      stubFetch(() =>
        jsonResponse(
          { error: "invalid_request", error_description: "Unknown or expired request" },
          { status: 404 },
        ),
      );

      const err = await client.getContext(requestId).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(AuthorizeError);
      expect((err as AuthorizeError).code).toBe("invalid_request");
      expect((err as AuthorizeError).status).toBe(404);
      expect((err as AuthorizeError).terminal).toBe(true);
      expect((err as AuthorizeError).needsSignIn).toBe(false);
      expect((err as AuthorizeError).message).toBe("Unknown or expired request");
    });

    it("maps a 429 to rate_limited whatever the body says", async () => {
      stubFetch(() => jsonResponse({ error: "too_many_requests" }, { status: 429 }));

      const err = (await client.getContext(requestId).catch((e: unknown) => e)) as AuthorizeError;

      expect(err.code).toBe("rate_limited");
      expect(err.terminal).toBe(false);
    });

    it("rejects a 200 whose body is not a context", async () => {
      stubFetch(() => jsonResponse({ scopes: ["openid"] }));

      const err = (await client.getContext(requestId).catch((e: unknown) => e)) as AuthorizeError;

      expect(err).toBeInstanceOf(AuthorizeError);
      expect(err.code).toBe("unknown");
    });

    it("survives a non-JSON error body", async () => {
      stubFetch(() => new Response("gateway down", { status: 502 }));

      const err = (await client.getContext(requestId).catch((e: unknown) => e)) as AuthorizeError;

      expect(err.code).toBe("unknown");
      expect(err.status).toBe(502);
      expect(err.message).toBe("Request failed: 502");
    });

    it("defaults a missing signedIn to false and profiles to empty", async () => {
      stubFetch(() =>
        jsonResponse({ client: sampleContext.client, scopes: ["openid"], linkedProfileId: null }),
      );

      const context = await client.getContext(requestId);

      expect(context.signedIn).toBe(false);
      expect(context.profiles).toEqual([]);
    });
  });

  describe("submitDecision", () => {
    it("posts the decision and returns the redirect verbatim", async () => {
      const redirectTo = "https://app.example.com/cb?code=abc&state=xyz";
      const { calls } = stubFetch(() => jsonResponse({ redirectTo }));

      const result = await client.submitDecision({
        requestId,
        profileId: "usr_1",
        approved: true,
      });

      expect(calls[0]?.url).toBe("https://osn.example.com/authorize/decision");
      expect(calls[0]?.init?.method).toBe("POST");
      expect(calls[0]?.init?.credentials).toBe("include");
      expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
        requestId,
        profileId: "usr_1",
        approved: true,
      });
      expect(result.redirectTo).toBe(redirectTo);
    });

    it("carries a denial as a decision, not an abandonment", async () => {
      const { calls } = stubFetch(() =>
        jsonResponse({ redirectTo: "https://app.example.com/cb?error=access_denied" }),
      );

      await client.submitDecision({ requestId, profileId: "usr_1", approved: false });

      expect(JSON.parse(String(calls[0]?.init?.body)).approved).toBe(false);
    });

    it("flags login_required as retryable with the same request id", async () => {
      stubFetch(() =>
        jsonResponse(
          { error: "login_required", error_description: "Re-authentication required" },
          { status: 400 },
        ),
      );

      const err = (await client
        .submitDecision({ requestId, profileId: "usr_1", approved: true })
        .catch((e: unknown) => e)) as AuthorizeError;

      expect(err.code).toBe("login_required");
      expect(err.needsSignIn).toBe(true);
      expect(err.terminal).toBe(false);
    });

    it("flags a 401 unauthorized as a first sign-in", async () => {
      stubFetch(() => jsonResponse({ error: "unauthorized" }, { status: 401 }));

      const err = (await client
        .submitDecision({ requestId, profileId: "usr_1", approved: true })
        .catch((e: unknown) => e)) as AuthorizeError;

      expect(err.code).toBe("unauthorized");
      expect(err.needsSignIn).toBe(true);
    });

    it("treats invalid_client as terminal even though it arrives as a 401", async () => {
      stubFetch(() =>
        jsonResponse(
          { error: "invalid_client", error_description: "Client is no longer available" },
          { status: 401 },
        ),
      );

      const err = (await client
        .submitDecision({ requestId, profileId: "usr_1", approved: true })
        .catch((e: unknown) => e)) as AuthorizeError;

      expect(err.code).toBe("invalid_client");
      expect(err.terminal).toBe(true);
      expect(err.needsSignIn).toBe(false);
    });

    it("rejects a 200 with no redirect", async () => {
      stubFetch(() => jsonResponse({}));

      const err = (await client
        .submitDecision({ requestId, profileId: "usr_1", approved: true })
        .catch((e: unknown) => e)) as AuthorizeError;

      expect(err).toBeInstanceOf(AuthorizeError);
      expect(err.code).toBe("unknown");
    });
  });
});
