import { describe, expect, it } from "bun:test";

import { Effect } from "effect";

import { type StripeClient, StripeError, type StripePrice } from "../../src/services/stripe";
import { createUpgradeCatalogue, PRICE_CACHE_TTL_MS } from "../../src/services/upgrade-catalogue";

/**
 * What matters here is what the catalogue REFUSES to do: sell a tier with no
 * configured Price, offer a tier the wedding already has, charge a Gold
 * wedding the full Crimson price, spend a Stripe call per page load, or let one
 * broken Price take the other tier's offer down with it.
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

const ALL_PRICES = { gold: "price_g", crimson: "price_c", crimsonFromGold: "price_cg" };
const ALL_AMOUNTS = { price_g: AUD(4900), price_c: AUD(9900), price_cg: AUD(5000) };

describe("createUpgradeCatalogue", () => {
  it("offers an Ivory wedding both tiers, each at its own Price", async () => {
    const { stripe } = stubStripe(ALL_AMOUNTS);
    const cat = createUpgradeCatalogue({ stripe, prices: ALL_PRICES });

    expect(cat.sellable("ivory")).toEqual(["gold", "crimson"]);
    expect(await Effect.runPromise(cat.list("ivory"))).toEqual([
      {
        tier: "gold",
        fromTier: "ivory",
        title: "Gold",
        blurb: "Your budget, checklist and gift registry, for up to 500 guests.",
        priceId: "price_g",
        amountMinor: 4900,
        currency: "AUD",
      },
      {
        tier: "crimson",
        fromTier: "ivory",
        title: "Crimson",
        blurb:
          "Everything in Gold, plus vendors and premium invite designs, for up to 1,000 guests.",
        priceId: "price_c",
        amountMinor: 9900,
        currency: "AUD",
      },
    ]);
  });

  it("offers a Gold wedding only Crimson, at the upgrade-from-Gold Price", async () => {
    const { stripe, reads } = stubStripe(ALL_AMOUNTS);
    const cat = createUpgradeCatalogue({ stripe, prices: ALL_PRICES });

    expect(cat.priceIdFor("gold", "gold")).toBeNull();
    expect(cat.priceIdFor("crimson", "gold")).toBe("price_cg");
    const list = await Effect.runPromise(cat.list("gold"));
    expect(
      list.map(({ tier, fromTier, priceId, amountMinor }) => ({
        tier,
        fromTier,
        priceId,
        amountMinor,
      })),
    ).toEqual([{ tier: "crimson", fromTier: "gold", priceId: "price_cg", amountMinor: 5000 }]);
    expect(reads).toEqual(["price_cg"]);
  });

  it("never offers a Gold wedding Crimson at the full Price when the upgrade Price is unset", async () => {
    const { stripe, reads } = stubStripe(ALL_AMOUNTS);
    const cat = createUpgradeCatalogue({
      stripe,
      prices: { gold: "price_g", crimson: "price_c" },
    });
    expect(cat.priceIdFor("crimson", "gold")).toBeNull();
    expect(await Effect.runPromise(cat.list("gold"))).toEqual([]);
    expect(reads).toEqual([]);
    // An Ivory wedding is still offered Crimson outright.
    expect(cat.priceIdFor("crimson", "ivory")).toBe("price_c");
  });

  it("offers a Crimson wedding nothing", async () => {
    const { stripe, reads } = stubStripe(ALL_AMOUNTS);
    const cat = createUpgradeCatalogue({ stripe, prices: ALL_PRICES });
    expect(cat.sellable("crimson")).toEqual([]);
    expect(await Effect.runPromise(cat.list("crimson"))).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("does not sell a tier with no configured Price", async () => {
    // The fail-closed half: absent configuration means no payment surface, and
    // must never mean "free".
    const { stripe, reads } = stubStripe({ price_g: AUD(4900) });
    const cat = createUpgradeCatalogue({ stripe, prices: { gold: "price_g" } });

    expect(cat.sellable("ivory")).toEqual(["gold"]);
    expect(cat.priceIdFor("crimson", "ivory")).toBeNull();
    const list = await Effect.runPromise(cat.list("ivory"));
    expect(list.map((e) => e.tier)).toEqual(["gold"]);
    expect(reads).toEqual(["price_g"]);
  });

  it("treats a blank or whitespace Price id as unconfigured", async () => {
    // An empty var is how a deployment that has not set one up actually looks.
    const { stripe } = stubStripe({});
    const cat = createUpgradeCatalogue({
      stripe,
      prices: { gold: "   ", crimson: "", crimsonFromGold: " " },
    });
    expect(cat.sellable("ivory")).toEqual([]);
    expect(cat.sellable("gold")).toEqual([]);
    expect(await Effect.runPromise(cat.list("ivory"))).toEqual([]);
  });

  it("drops a broken Price without taking the other tier's offer down", async () => {
    // One misconfigured Price is an operator mistake; the whole upgrade surface
    // disappearing because of it is an outage.
    const { stripe } = stubStripe({ price_g: AUD(4900), price_c: "fail" });
    const cat = createUpgradeCatalogue({
      stripe,
      prices: { gold: "price_g", crimson: "price_c" },
    });

    const list = await Effect.runPromise(cat.list("ivory"));
    expect(list.map((e) => e.tier)).toEqual(["gold"]);
  });

  it("reads a Price once per TTL, not once per page load", async () => {
    // The catalogue is fetched on every visit to a locked module. Without the
    // cache each of those spends an outbound Stripe call on an answer that has
    // not moved, against the PLATFORM's quota.
    let clock = 1_000_000;
    const { stripe, reads } = stubStripe({ price_g: AUD(4900) });
    const cat = createUpgradeCatalogue({
      stripe,
      prices: { gold: "price_g" },
      now: () => clock,
    });

    await Effect.runPromise(cat.list("ivory"));
    await Effect.runPromise(cat.list("ivory"));
    await Effect.runPromise(cat.list("ivory"));
    expect(reads).toEqual(["price_g"]);

    clock += PRICE_CACHE_TTL_MS + 1;
    await Effect.runPromise(cat.list("ivory"));
    expect(reads).toEqual(["price_g", "price_g"]);
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
    const cat = createUpgradeCatalogue({ stripe: client, prices: { gold: "price_g" } });

    expect(await Effect.runPromise(cat.list("ivory"))).toEqual([]);
    answer = AUD(4900);
    const list = await Effect.runPromise(cat.list("ivory"));
    expect(list.map((e) => e.amountMinor)).toEqual([4900]);
    expect(reads).toEqual(["price_g", "price_g"]);
  });
});
