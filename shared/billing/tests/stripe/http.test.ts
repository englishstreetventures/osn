import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import {
  createStripeRequest,
  encodeStripeForm,
  STRIPE_API_VERSION,
  type StripeError,
} from "../../src/stripe/http";

interface Call {
  url: string;
  init: RequestInit;
}

/** A `fetch` that records each call and answers with `respond`. */
function recorder(respond: (call: Call) => Response | Promise<Response> = () => Response.json({})) {
  const calls: Call[] = [];
  const fetchImpl = (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(respond(call));
  };
  return { calls, fetchImpl };
}

const fail = (effect: Effect.Effect<unknown, StripeError>) =>
  Effect.runPromise(Effect.flip(effect));

describe("createStripeRequest", () => {
  it("puts GET parameters in the query string, arrays indexed", async () => {
    const { calls, fetchImpl } = recorder(() => Response.json({ data: [] }));
    const request = createStripeRequest({ secretKey: "sk_test_1", fetchImpl });
    await Effect.runPromise(
      request("GET", "/v1/prices", {
        lookup_keys: ["plan_monthly", "plan_annual"],
        active: true,
        expand: ["data.currency_options"],
        limit: 100,
      }),
    );
    expect(decodeURIComponent(calls[0]!.url)).toBe(
      "https://api.stripe.com/v1/prices?lookup_keys[0]=plan_monthly&lookup_keys[1]=plan_annual" +
        "&active=true&expand[0]=data.currency_options&limit=100",
    );
    expect(calls[0]!.init.body).toBeUndefined();
    expect(new Headers(calls[0]!.init.headers).get("content-type")).toBeNull();
  });

  it("sends a POST as a form with the pinned version, the key and the idempotency key", async () => {
    const { calls, fetchImpl } = recorder();
    const request = createStripeRequest({ secretKey: "sk_test_1", fetchImpl });
    await Effect.runPromise(
      request(
        "POST",
        "/v1/customers",
        { metadata: { billing_customer: "bcus_1" } },
        {
          idempotencyKey: "billing-customer-bcus_1",
        },
      ),
    );
    const headers = new Headers(calls[0]!.init.headers);
    expect(calls[0]!.url).toBe("https://api.stripe.com/v1/customers");
    expect(headers.get("authorization")).toBe("Bearer sk_test_1");
    expect(headers.get("stripe-version")).toBe(STRIPE_API_VERSION);
    expect(headers.get("idempotency-key")).toBe("billing-customer-bcus_1");
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(decodeURIComponent(String(calls[0]!.init.body))).toBe(
      "metadata[billing_customer]=bcus_1",
    );
  });

  it("fails as a timeout when the connection hangs", async () => {
    const fetchImpl = () => new Promise<Response>(() => {});
    const request = createStripeRequest({ secretKey: "sk", fetchImpl, timeoutMs: 20 });
    expect((await fail(request("GET", "/v1/prices"))).reason).toBe("timeout");
  });

  it("fails as a timeout when the body never finishes, and aborts the connection", async () => {
    let signal: AbortSignal | undefined;
    const fetchImpl = (_input: RequestInfo | URL, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      // Headers arrive; the body stream never closes.
      return Promise.resolve(new Response(new ReadableStream({ start() {} }), { status: 200 }));
    };
    const request = createStripeRequest({ secretKey: "sk", fetchImpl, timeoutMs: 20 });
    expect((await fail(request("GET", "/v1/prices"))).reason).toBe("timeout");
    expect(signal?.aborted).toBe(true);
  });

  it("keeps Stripe's error code and never its message", async () => {
    const { fetchImpl } = recorder(() =>
      Response.json(
        { error: { code: "resource_missing", message: "No such price: 'price_secret'" } },
        { status: 404 },
      ),
    );
    const error = await fail(createStripeRequest({ secretKey: "sk", fetchImpl })("GET", "/v1/x"));
    expect([error.reason, error.status, error.code]).toEqual(["rejected", 404, "resource_missing"]);
    expect(JSON.stringify(error)).not.toContain("price_secret");
  });

  it("calls a body that is not JSON unreadable", async () => {
    const { fetchImpl } = recorder(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const error = await fail(createStripeRequest({ secretKey: "sk", fetchImpl })("GET", "/v1/x"));
    expect([error.reason, error.status, error.code]).toEqual(["unreadable", 502, undefined]);
  });

  it("fails as a value when the network throws", async () => {
    const fetchImpl = () => Promise.reject(new TypeError("network down"));
    const error = await fail(createStripeRequest({ secretKey: "sk", fetchImpl })("GET", "/v1/x"));
    expect(error.reason).toBe("unreachable");
  });
});

describe("encodeStripeForm", () => {
  it("drops absent fields rather than sending them empty", () => {
    expect(encodeStripeForm({ a: "1", b: null, c: undefined, d: { e: undefined } })).toBe("a=1");
  });
});
