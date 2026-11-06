import { describe, expect, it } from "bun:test";

import { localStripeOrigins } from "../../src/lib/local-stripe";

/**
 * The local dev server can point Stripe calls at a stand-in. Every call made
 * there carries the platform's secret key, so the override is refused unless it
 * names this machine.
 */
describe("localStripeOrigins", () => {
  it("is nothing when neither override is set", () => {
    expect(localStripeOrigins({})).toEqual({});
    expect(localStripeOrigins({ STRIPE_API_URL: " ", STRIPE_CONNECT_URL: "" })).toEqual({});
  });

  it("takes a loopback origin for either host, without a trailing slash", () => {
    expect(
      localStripeOrigins({
        STRIPE_API_URL: "http://127.0.0.1:4810/",
        STRIPE_CONNECT_URL: "http://localhost:4810",
      }),
    ).toEqual({ apiBase: "http://127.0.0.1:4810", connectBase: "http://localhost:4810" });
  });

  it("refuses anything that is not this machine", () => {
    for (const value of [
      "https://api.stripe.com",
      "http://127.0.0.1.evil.example:4810",
      "http://user:pass@127.0.0.1:4810",
      "http://127.0.0.1:4810/v1",
      "ftp://127.0.0.1",
      "not a url",
    ]) {
      expect(() => localStripeOrigins({ STRIPE_API_URL: value })).toThrow(/STRIPE_API_URL/);
      expect(() => localStripeOrigins({ STRIPE_CONNECT_URL: value })).toThrow(/STRIPE_CONNECT_URL/);
    }
  });

  it("never repeats the refused value", () => {
    let message = "";
    try {
      localStripeOrigins({ STRIPE_API_URL: "https://secret-host.example" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("STRIPE_API_URL");
    expect(message).not.toContain("secret-host");
  });
});
