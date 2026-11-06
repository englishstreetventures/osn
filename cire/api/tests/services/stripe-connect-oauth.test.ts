import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import {
  createStripeConnectOAuth,
  STRIPE_OAUTH_CALLBACK_PATH,
  stripeConnectOAuthFromEnv,
} from "../../src/services/stripe-connect-oauth";

/**
 * The OAuth client's contract with Stripe: what it sends, what it keeps of the
 * token reply, and that a refusal carries Stripe's code and never its words.
 */

interface Sent {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

function fetchReturning(status: number, body: unknown) {
  const sent: Sent[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { fetchImpl, sent };
}

const client = (fetchImpl: typeof fetch) =>
  createStripeConnectOAuth({
    secretKey: "sk_test_platform",
    clientId: "ca_platform",
    redirectUri: "https://api.test/api/organiser/stripe/oauth/callback",
    connectBase: "https://connect.test",
    fetchImpl,
  });

describe("authorizeUrl", () => {
  it("is always Stripe's own page, whatever host the server calls go to", () => {
    const url = new URL(client(fetchReturning(200, {}).fetchImpl).authorizeUrl("wed_a.abc"));
    expect(url.origin).toBe("https://connect.stripe.com");
    expect(url.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "ca_platform",
      scope: "read_write",
      state: "wed_a.abc",
      redirect_uri: "https://api.test/api/organiser/stripe/oauth/callback",
    });
  });
});

describe("exchangeCode", () => {
  it("posts the code with the platform key and keeps only the account id", async () => {
    const { fetchImpl, sent } = fetchReturning(200, {
      stripe_user_id: "acct_123",
      scope: "read_write",
      livemode: false,
      token_type: "bearer",
      access_token: "sk_test_deprecated_access_token",
      refresh_token: "rt_deprecated",
      stripe_publishable_key: "pk_test_deprecated",
    });
    const result = await Effect.runPromise(client(fetchImpl).exchangeCode("ac_code"));
    expect(result).toEqual({ accountId: "acct_123" });
    expect(JSON.stringify(result)).not.toContain("deprecated");
    const [call] = sent;
    expect(call?.url).toBe("https://connect.test/oauth/token");
    expect(call?.method).toBe("POST");
    expect(call?.headers.get("authorization")).toBe("Bearer sk_test_platform");
    expect(new URLSearchParams(call?.body)).toEqual(
      new URLSearchParams({ grant_type: "authorization_code", code: "ac_code" }),
    );
  });

  it("refuses with Stripe's code and never its description", async () => {
    const { fetchImpl } = fetchReturning(400, {
      error: "invalid_grant",
      error_description: "Authorization code does not exist: ac_code",
    });
    const error = await Effect.runPromise(Effect.flip(client(fetchImpl).exchangeCode("ac_code")));
    expect(error._tag).toBe("StripeError");
    expect(error).toMatchObject({ reason: "rejected", status: 400, code: "invalid_grant" });
    expect(JSON.stringify(error)).not.toContain("ac_code");
  });

  it("refuses a reply with no account id or another scope, naming any id it carried", async () => {
    for (const [body, id] of [
      [{ scope: "read_write" }, null],
      [{ stripe_user_id: "not-an-account", scope: "read_write" }, null],
      [{ stripe_user_id: "acct_123", scope: "read_only" }, "acct_123"],
    ] as const) {
      const error = await Effect.runPromise(
        Effect.flip(client(fetchReturning(200, body).fetchImpl).exchangeCode("ac")),
      );
      expect(error._tag).toBe("OAuthReplyError");
      expect(error).toMatchObject({ connectedAccountId: id });
    }
  });

  it("calls a body that is not JSON unreadable", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        client(fetchReturning(502, "<html>bad gateway</html>").fetchImpl).exchangeCode("ac"),
      ),
    );
    expect(error).toMatchObject({ reason: "unreadable", status: 502 });
  });
});

describe("deauthorize", () => {
  it("posts the client id and the account", async () => {
    const { fetchImpl, sent } = fetchReturning(200, { stripe_user_id: "acct_123" });
    await Effect.runPromise(client(fetchImpl).deauthorize("acct_123"));
    expect(sent[0]?.url).toBe("https://connect.test/oauth/deauthorize");
    expect(new URLSearchParams(sent[0]?.body)).toEqual(
      new URLSearchParams({ client_id: "ca_platform", stripe_user_id: "acct_123" }),
    );
  });
});

describe("stripeConnectOAuthFromEnv", () => {
  const env = {
    STRIPE_SECRET_KEY: "sk_test_platform",
    STRIPE_CONNECT_CLIENT_ID: "ca_platform",
    CIRE_API_ORIGIN: "https://api.test/",
  };

  it("builds the client with the callback on cire-api's own origin", () => {
    const { oauth, gap } = stripeConnectOAuthFromEnv(env);
    expect(gap).toBeNull();
    expect(oauth?.redirectUri).toBe(`https://api.test${STRIPE_OAUTH_CALLBACK_PATH}`);
  });

  it("is off without the key, the client id or the origin, and says nothing", () => {
    for (const missing of ["STRIPE_SECRET_KEY", "STRIPE_CONNECT_CLIENT_ID", "CIRE_API_ORIGIN"]) {
      expect(stripeConnectOAuthFromEnv({ ...env, [missing]: " " })).toEqual({
        oauth: null,
        gap: null,
      });
    }
  });

  it("refuses a client id that is not a ca_ id, and says so", () => {
    for (const id of ["sk_test_wrong_value", "ca_", "ca_has space"]) {
      expect(stripeConnectOAuthFromEnv({ ...env, STRIPE_CONNECT_CLIENT_ID: id })).toEqual({
        oauth: null,
        gap: "malformed_client_id",
      });
    }
  });
});
