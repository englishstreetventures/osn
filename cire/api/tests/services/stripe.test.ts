import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import {
  createStripeClient,
  createStripeClientFromEnv,
  encodeStripeForm,
  STRIPE_API_VERSION,
  verifyStripeWebhook,
  WEBHOOK_TOLERANCE_SECONDS,
} from "../../src/services/stripe";

/**
 * The Stripe client, and the webhook check that decides whether a body is
 * allowed to move money's record.
 *
 * What is load-bearing here:
 *   - the form encoding IS the API contract (`capabilities[card_payments]`);
 *   - a retried "connect" cannot mint a second account for one couple;
 *   - Stripe's error MESSAGE never leaves the client — only its code;
 *   - the webhook check refuses an unsigned, mis-signed, stale or unconfigured
 *     delivery, and each for its own reason.
 */

const SECRET = "whsec_test_secret";

function stubFetch(handler: (url: string, init: RequestInit) => Response) {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return handler(String(input), init ?? {});
  }) as unknown as typeof fetch;
  return { impl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const ACCOUNT = {
  id: "acct_123",
  charges_enabled: true,
  payouts_enabled: false,
  details_submitted: true,
  default_currency: "aud",
};

async function hmacHex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

describe("encodeStripeForm", () => {
  it("nests the way Stripe reads it", () => {
    expect(
      encodeStripeForm({
        type: "express",
        capabilities: { card_payments: { requested: true } },
        metadata: { weddingId: "wed_1" },
      }),
    ).toBe(
      "type=express&capabilities%5Bcard_payments%5D%5Brequested%5D=true&metadata%5BweddingId%5D=wed_1",
    );
  });

  it("drops absent fields rather than sending them empty", () => {
    // To Stripe an empty string is a value — "unset this field" — which is a
    // different request from not naming the field at all.
    expect(encodeStripeForm({ email: null, country: "AU" })).toBe("country=AU");
    expect(encodeStripeForm({ email: undefined, country: "AU" })).toBe("country=AU");
  });

  it("escapes values that would otherwise change the shape of the body", () => {
    expect(encodeStripeForm({ return_url: "https://x.test/a?b=c&d=e" })).toBe(
      "return_url=https%3A%2F%2Fx.test%2Fa%3Fb%3Dc%26d%3De",
    );
  });
});

describe("createStripeClient", () => {
  it("creates an express account, pinned to an API version and keyed per wedding", async () => {
    const { impl, calls } = stubFetch(() => json(ACCOUNT));
    const client = createStripeClient({
      secretKey: "sk_test",
      apiBase: "https://stripe.test",
      fetchImpl: impl,
    });

    const account = await Effect.runPromise(
      client.createAccount({ country: "AU", email: "a@b.test", weddingId: "wed_1" }),
    );

    expect(account).toEqual({
      id: "acct_123",
      chargesEnabled: true,
      payoutsEnabled: false,
      detailsSubmitted: true,
      // Stripe sends the settlement currency lower-case; every currency this
      // product compares or stores is upper-case, so the boundary normalises it.
      defaultCurrency: "AUD",
    });
    const call = calls[0];
    expect(call?.url).toBe("https://stripe.test/v1/accounts");
    const headers = call?.init.headers as Headers;
    expect(headers.get("authorization")).toBe("Bearer sk_test");
    expect(headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    // A double-submitted "connect" button must not mint two accounts for one
    // couple — that failure needs a human at Stripe to unpick.
    expect(headers.get("idempotency-key")).toBe("cire-account-wed_1");
    expect(String(call?.init.body)).toContain(
      "capabilities%5Bcard_payments%5D%5Brequested%5D=true",
    );
  });

  it("reports no settlement currency rather than guessing one", async () => {
    const { impl } = stubFetch(() =>
      json({ id: "acct_123", charges_enabled: false, payouts_enabled: false }),
    );
    const client = createStripeClient({
      secretKey: "sk_test",
      apiBase: "https://stripe.test",
      fetchImpl: impl,
    });

    const account = await Effect.runPromise(client.retrieveAccount("acct_123"));

    // A brand-new account has no settlement currency yet. Null is the honest
    // answer: the settings route reads it as "not known", not as a mismatch.
    expect(account.defaultCurrency).toBeNull();
  });

  it("returns Stripe's code and never its message", async () => {
    const { impl, calls } = stubFetch(() =>
      json(
        {
          error: {
            code: "account_invalid",
            message: "No such account: acct_secret; the key sk_live_abc was used",
          },
        },
        400,
      ),
    );
    const client = createStripeClient({ secretKey: "sk_test", fetchImpl: impl });

    const failure = await Effect.runPromise(Effect.flip(client.retrieveAccount("acct_missing")));

    expect(failure.reason).toBe("rejected");
    expect(failure.status).toBe(400);
    expect(failure.code).toBe("account_invalid");
    // The account read is a GET at the account's own path — asserted here
    // because every other test of it goes through an error path.
    const call = calls[0];
    expect(call?.init.method).toBe("GET");
    expect(call?.url).toContain("/v1/accounts/acct_missing");
    // Stripe writes `message` for a developer's console and quotes the request
    // back into it. Nothing that reaches a log line may carry it.
    expect(JSON.stringify(failure)).not.toContain("sk_live_abc");
  });

  it("fails as a value when the network does, never as a throw", async () => {
    const impl = (() => Promise.reject(new Error("offline"))) as unknown as typeof fetch;
    const client = createStripeClient({ secretKey: "sk_test", fetchImpl: impl });
    const failure = await Effect.runPromise(Effect.flip(client.retrieveAccount("acct_1")));
    expect(failure.reason).toBe("unreachable");
  });

  it("refuses a 200 that is not the account it asked for", async () => {
    const { impl } = stubFetch(() => json({ object: "account" }));
    const client = createStripeClient({ secretKey: "sk_test", fetchImpl: impl });
    const failure = await Effect.runPromise(Effect.flip(client.retrieveAccount("acct_1")));
    expect(failure.reason).toBe("unexpected account payload");
  });

  it("mints a hosted onboarding link with both return paths", async () => {
    const { impl, calls } = stubFetch(() =>
      json({ url: "https://connect.stripe.test/setup/abc", expires_at: 1_800_000_000 }),
    );
    const client = createStripeClient({ secretKey: "sk_test", fetchImpl: impl });

    const link = await Effect.runPromise(
      client.createAccountLink({
        accountId: "acct_123",
        refreshUrl: "https://host.test/refresh",
        returnUrl: "https://host.test/return",
      }),
    );

    expect(link.url).toBe("https://connect.stripe.test/setup/abc");
    expect(link.expiresAt).toBe(1_800_000_000);
    const body = String(calls[0]?.init.body);
    expect(body).toContain("type=account_onboarding");
    expect(body).toContain("refresh_url=");
    expect(body).toContain("return_url=");
  });
});

describe("createCheckoutSession", () => {
  const INPUT = {
    accountId: "acct_couple",
    amountMinor: 12_500,
    currency: "AUD",
    productName: "Wedding gift",
    successUrl: "https://invite.test/x/registry?gift=thanks",
    cancelUrl: "https://invite.test/x/registry?gift=cancelled",
    metadata: { contributionId: "rct_1" },
    // The one field a connected account cannot rewrite — the settle path reads
    // it before it reads any metadata.
    clientReferenceId: "rct_1",
    idempotencyKey: "cire-gift-abc",
  };

  /**
   * THE HEADER IS THE WHOLE MECHANISM. Without `Stripe-Account` the session is
   * created on the PLATFORM's account: the money lands in cire's balance
   * instead of the couple's, and the product is doing money transmission —
   * the exact thing the Connect design exists to avoid. It is also the hardest
   * failure to notice in production, because the guest still pays and still
   * gets a receipt.
   */
  it("acts as the couple's connected account, which is what makes the charge direct", async () => {
    const { impl, calls } = stubFetch(() => json({ id: "cs_1", url: "https://pay.test/cs_1" }));
    const client = createStripeClient({
      secretKey: "sk_test",
      apiBase: "https://stripe.test",
      fetchImpl: impl,
    });

    const session = await Effect.runPromise(client.createCheckoutSession(INPUT));

    expect(session).toEqual({ id: "cs_1", url: "https://pay.test/cs_1" });
    const call = calls[0];
    expect(call?.url).toBe("https://stripe.test/v1/checkout/sessions");
    const headers = call?.init.headers as Headers;
    expect(headers.get("stripe-account")).toBe("acct_couple");
    // And the caller's key rides along: one press, one session.
    expect(headers.get("idempotency-key")).toBe("cire-gift-abc");
  });

  it("prices the gift inline, in minor units", async () => {
    const { impl, calls } = stubFetch(() => json({ id: "cs_1", url: "https://pay.test/cs_1" }));
    const client = createStripeClient({ secretKey: "sk_test", fetchImpl: impl });

    await Effect.runPromise(client.createCheckoutSession(INPUT));

    const body = String(calls[0]?.init.body);
    expect(body).toContain("mode=payment");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bunit_amount%5D=12500");
    expect(body).toContain("line_items%5B0%5D%5Bprice_data%5D%5Bcurrency%5D=aud");
    expect(body).toContain("metadata%5BcontributionId%5D=rct_1");
  });

  it("refuses a 200 that is not a session it can send anyone to", async () => {
    const { impl } = stubFetch(() => json({ id: "cs_1" }));
    const client = createStripeClient({ secretKey: "sk_test", fetchImpl: impl });
    const failure = await Effect.runPromise(Effect.flip(client.createCheckoutSession(INPUT)));
    expect(failure.reason).toBe("unexpected checkout session payload");
  });
});

describe("createStripeClientFromEnv", () => {
  it("is null without a key — a deployment with no Stripe has no payment surface", () => {
    expect(createStripeClientFromEnv({})).toBeNull();
    expect(createStripeClientFromEnv({ STRIPE_SECRET_KEY: "" })).toBeNull();
    expect(createStripeClientFromEnv({ STRIPE_SECRET_KEY: "   " })).toBeNull();
  });

  it("builds a client when a key is set", () => {
    expect(createStripeClientFromEnv({ STRIPE_SECRET_KEY: "sk_test" })).not.toBeNull();
  });
});

describe("verifyStripeWebhook", () => {
  const now = 1_800_000_000;
  const body = JSON.stringify({ id: "evt_1", type: "account.updated" });

  async function signedHeader(at = now, secret = SECRET): Promise<string> {
    return `t=${at},v1=${await hmacHex(secret, `${at}.${body}`)}`;
  }

  it("accepts a delivery Stripe signed, and returns the parsed body", async () => {
    const event = await Effect.runPromise(
      verifyStripeWebhook({
        payload: body,
        signatureHeader: await signedHeader(),
        secret: SECRET,
        now,
      }),
    );
    expect(event).toEqual({ id: "evt_1", type: "account.updated" });
  });

  it("accepts a delivery signed with any of several rotating secrets", async () => {
    const header = `t=${now},v1=${await hmacHex("whsec_old", `${now}.${body}`)},v1=${await hmacHex(
      SECRET,
      `${now}.${body}`,
    )}`;
    await Effect.runPromise(
      verifyStripeWebhook({ payload: body, signatureHeader: header, secret: SECRET, now }),
    );
  });

  it("refuses a delivery nobody signed", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        verifyStripeWebhook({ payload: body, signatureHeader: null, secret: SECRET, now }),
      ),
    );
    expect(failure.reason).toBe("malformed");
  });

  it("refuses a header without the parts the check needs", async () => {
    for (const header of ["", "t=123", `v1=${"0".repeat(64)}`, "nonsense"]) {
      const failure = await Effect.runPromise(
        Effect.flip(
          verifyStripeWebhook({ payload: body, signatureHeader: header, secret: SECRET, now }),
        ),
      );
      expect(failure.reason).toBe("malformed");
    }
  });

  it("refuses a body that was changed after signing", async () => {
    const header = await signedHeader();
    const failure = await Effect.runPromise(
      Effect.flip(
        verifyStripeWebhook({
          payload: JSON.stringify({ id: "evt_1", type: "account.updated", extra: true }),
          signatureHeader: header,
          secret: SECRET,
          now,
        }),
      ),
    );
    expect(failure.reason).toBe("no-match");
  });

  it("refuses a signature made with another secret", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        verifyStripeWebhook({
          payload: body,
          signatureHeader: await signedHeader(now, "whsec_someone_else"),
          secret: SECRET,
          now,
        }),
      ),
    );
    expect(failure.reason).toBe("no-match");
  });

  /**
   * A valid signature is valid forever. Without the window, a delivery captured
   * once can be replayed at any point in the future — against the handler that
   * records money, which is the handler this exists for.
   */
  it("refuses a delivery older than the tolerance, and one from the future", async () => {
    const stale = now - WEBHOOK_TOLERANCE_SECONDS - 1;
    const staleFailure = await Effect.runPromise(
      Effect.flip(
        verifyStripeWebhook({
          payload: body,
          signatureHeader: await signedHeader(stale),
          secret: SECRET,
          now,
        }),
      ),
    );
    expect(staleFailure.reason).toBe("too-old");

    const ahead = now + WEBHOOK_TOLERANCE_SECONDS + 1;
    const aheadFailure = await Effect.runPromise(
      Effect.flip(
        verifyStripeWebhook({
          payload: body,
          signatureHeader: await signedHeader(ahead),
          secret: SECRET,
          now,
        }),
      ),
    );
    expect(aheadFailure.reason).toBe("too-old");
  });

  it("accepts one at the edge of the window", async () => {
    await Effect.runPromise(
      verifyStripeWebhook({
        payload: body,
        signatureHeader: await signedHeader(now - WEBHOOK_TOLERANCE_SECONDS),
        secret: SECRET,
        now,
      }),
    );
  });

  /**
   * With no signing secret nothing can be verified, so nothing is accepted.
   * The alternative — trusting the body — is how a webhook endpoint becomes an
   * unauthenticated write API.
   */
  it("refuses everything when no signing secret is configured", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(
        verifyStripeWebhook({
          payload: body,
          signatureHeader: await signedHeader(),
          secret: null,
          now,
        }),
      ),
    );
    expect(failure.reason).toBe("unconfigured");
  });

  it("refuses a signed body that is not JSON", async () => {
    const payload = "not json";
    const header = `t=${now},v1=${await hmacHex(SECRET, `${now}.${payload}`)}`;
    const failure = await Effect.runPromise(
      Effect.flip(verifyStripeWebhook({ payload, signatureHeader: header, secret: SECRET, now })),
    );
    expect(failure.reason).toBe("malformed");
  });
});
