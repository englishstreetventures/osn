import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import { type StripeClient, StripeError, type StripePrice } from "../../src/services/stripe";
import {
  createUpgradeCatalogue,
  isPurchasable,
  PRICE_CACHE_TTL_MS,
} from "../../src/services/upgrade-catalogue";

/**
 * What matters here is what the catalogue REFUSES to do: sell a key with no
 * configured Price, spend a Stripe call per page load, or let one broken Price
 * take the other module's upgrade offer down with it.
 */

function stubStripe(prices: Record<string, StripePrice | "fail">): {
  stripe: StripeClient;
  reads: string[];
} {
  const reads: string[] = [];
  const client = {
    createAccount: () => Effect.fail(new StripeError({ reason: "not used here" })),
    createAccountLink: () => Effect.fail(new StripeError({ reason: "not used here" })),
    retrieveAccount: () => Effect.fail(new StripeError({ reason: "not used here" })),
    createCheckoutSession: () => Effect.fail(new StripeError({ reason: "not used here" })),
    retrieveCheckoutSession: () => Effect.fail(new StripeError({ reason: "not used here" })),
    createPlatformCheckoutSession: () => Effect.fail(new StripeError({ reason: "not used here" })),
    retrievePlatformCheckoutSession: () =>
      Effect.fail(new StripeError({ reason: "not used here" })),
    retrievePrice(priceId: string) {
      reads.push(priceId);
      const found = prices[priceId];
      if (found === undefined || found === "fail") {
        return Effect.fail(new StripeError({ reason: "rejected", status: 404 }));
      }
      return Effect.succeed(found);
    },
  } as unknown as StripeClient;
  return { stripe: client, reads };
}

const AUD = (n: number): StripePrice => ({ unitAmountMinor: n, currency: "AUD" });

describe("isPurchasable", () => {
  it("admits the two keys sold self-serve and nothing else", () => {
    expect(isPurchasable("vendors")).toBe(true);
    expect(isPurchasable("registry")).toBe(true);
    // Real entitlement keys, deliberately not for sale on this surface.
    expect(isPurchasable("capacity_500")).toBe(false);
    expect(isPurchasable("ai")).toBe(false);
    expect(isPurchasable("premium_templates")).toBe(false);
  });

  it("does not admit an inherited Object property", () => {
    // A membership test that walks the prototype chain would say yes here, and
    // the caller then treats `constructor` as a capability key.
    expect(isPurchasable("constructor")).toBe(false);
    expect(isPurchasable("toString")).toBe(false);
    expect(isPurchasable("__proto__")).toBe(false);
  });
});

describe("createUpgradeCatalogue", () => {
  it("does not sell a key with no configured Price", async () => {
    // The fail-closed half: absent configuration means no payment surface, and
    // must never mean "free".
    const { stripe, reads } = stubStripe({ price_v: AUD(4900) });
    const cat = createUpgradeCatalogue({ stripe, prices: { vendors: "price_v" } });

    expect(cat.sellable()).toEqual(["vendors"]);
    expect(cat.priceIdFor("registry")).toBeNull();
    const list = await Effect.runPromise(cat.list());
    expect(list.map((e) => e.entitlement)).toEqual(["vendors"]);
    expect(reads).toEqual(["price_v"]);
  });

  it("treats a blank or whitespace Price id as unconfigured", async () => {
    // An empty var is how a deployment that has not set one up actually looks.
    const { stripe } = stubStripe({});
    const cat = createUpgradeCatalogue({
      stripe,
      prices: { vendors: "   ", registry: "" },
    });
    expect(cat.sellable()).toEqual([]);
    expect(await Effect.runPromise(cat.list())).toEqual([]);
  });

  it("prices each entry from Stripe rather than from anything stored here", async () => {
    const { stripe } = stubStripe({ price_v: AUD(4900), price_r: AUD(2900) });
    const cat = createUpgradeCatalogue({
      stripe,
      prices: { vendors: "price_v", registry: "price_r" },
    });

    const list = await Effect.runPromise(cat.list());
    expect(list).toEqual([
      {
        entitlement: "vendors",
        title: "Vendors & directory",
        blurb: "Browse trusted wedding vendors and manage your shortlist in one place.",
        priceId: "price_v",
        amountMinor: 4900,
        currency: "AUD",
      },
      {
        entitlement: "registry",
        title: "Gift registry",
        blurb: "List the gifts you'd like, and see what guests have claimed and sent.",
        priceId: "price_r",
        amountMinor: 2900,
        currency: "AUD",
      },
    ]);
  });

  it("drops a broken Price without taking the other module's offer down", async () => {
    // One misconfigured key is an operator mistake; the whole upgrade surface
    // disappearing because of it is an outage.
    const { stripe } = stubStripe({ price_v: AUD(4900), price_r: "fail" });
    const cat = createUpgradeCatalogue({
      stripe,
      prices: { vendors: "price_v", registry: "price_r" },
    });

    const list = await Effect.runPromise(cat.list());
    expect(list.map((e) => e.entitlement)).toEqual(["vendors"]);
  });

  it("reads a Price once per TTL, not once per page load", async () => {
    // The catalogue is fetched on every visit to a locked module. Without the
    // cache each of those spends an outbound Stripe call on an answer that has
    // not moved, against the PLATFORM's quota.
    let clock = 1_000_000;
    const { stripe, reads } = stubStripe({ price_v: AUD(4900) });
    const cat = createUpgradeCatalogue({
      stripe,
      prices: { vendors: "price_v" },
      now: () => clock,
    });

    await Effect.runPromise(cat.list());
    await Effect.runPromise(cat.list());
    await Effect.runPromise(cat.list());
    expect(reads).toEqual(["price_v"]);

    clock += PRICE_CACHE_TTL_MS + 1;
    await Effect.runPromise(cat.list());
    expect(reads).toEqual(["price_v", "price_v"]);
  });

  it("does not cache a refusal, so a fixed Price recovers without a deploy", async () => {
    let answer: StripePrice | "fail" = "fail";
    const reads: string[] = [];
    const client = {
      retrievePrice(priceId: string) {
        reads.push(priceId);
        return answer === "fail"
          ? Effect.fail(new StripeError({ reason: "rejected", status: 404 }))
          : Effect.succeed(answer);
      },
    } as unknown as StripeClient;
    const cat = createUpgradeCatalogue({ stripe: client, prices: { vendors: "price_v" } });

    expect(await Effect.runPromise(cat.list())).toEqual([]);
    answer = AUD(4900);
    const list = await Effect.runPromise(cat.list());
    expect(list.map((e) => e.amountMinor)).toEqual([4900]);
    expect(reads).toEqual(["price_v", "price_v"]);
  });
});
