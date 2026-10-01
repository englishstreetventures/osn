/**
 * What a cire host can buy, and what it costs.
 *
 * NO MONEY AMOUNT LIVES IN THIS FILE, or anywhere else in this repository. An
 * entry names a Stripe Price id the deployment configured; the amount is read
 * back from Stripe. So changing what an upgrade costs is a dashboard change
 * plus a var, never a deploy — and there is no second copy of a price to drift
 * out of step with the one customers are actually charged.
 *
 * KEY-OPTIONAL, AND FAIL-CLOSED, like `createStripeClientFromEnv` and
 * `@shared/turnstile`: a tier with no configured Price id is simply not
 * purchasable. It never appears in the catalogue and the checkout route 404s
 * for it. Absent configuration means no payment surface — never "free".
 */

import { Effect } from "effect";

import { type StripeClient, StripeError, type StripePrice } from "./stripe";
import { PAID_TIERS, type PaidTier, type Tier, tierAtLeast } from "./tiers";

/** The tiers sold self-serve: every paid tier. */
export const PURCHASABLE_TIERS = PAID_TIERS;

export function isPurchasable(value: string): value is PaidTier {
  // `includes` on a closed readonly tuple walks no prototype chain.
  return (PURCHASABLE_TIERS as readonly string[]).includes(value);
}

/** The copy shown on the upgrade dialog. Not in the database: it is product
 *  writing that ships with the release, and a row would only let it drift from
 *  the modules it describes. */
const COPY = {
  gold: {
    title: "Gold",
    blurb: "Your budget, checklist and gift registry, for up to 500 guests.",
  },
  crimson: {
    title: "Crimson",
    blurb: "Everything in Gold, plus vendors and premium invite designs, for up to 1,000 guests.",
  },
} satisfies Record<PaidTier, { title: string; blurb: string }>;

/**
 * Stripe Price ids. `gold` and `crimson` are each tier's own Price, charged to
 * a wedding on Ivory. `crimsonFromGold` is a second Price on the Crimson
 * product, charged to a wedding already on Gold — and with it unset, Crimson is
 * not offered to a Gold wedding at all, never offered at the full price. A
 * Price absent here is not for sale in this deployment.
 */
export interface UpgradePriceConfig {
  gold?: string | undefined;
  crimson?: string | undefined;
  crimsonFromGold?: string | undefined;
}

/** One sellable upgrade, priced for the tier the wedding is on now. */
export interface CatalogueEntry {
  tier: PaidTier;
  /** The tier this Price upgrades from — the wedding's current tier. */
  fromTier: Tier;
  title: string;
  blurb: string;
  priceId: string;
  amountMinor: number;
  currency: string;
}

/**
 * How long a Price is trusted before it is read from Stripe again.
 *
 * The catalogue is read on every visit to a locked module, and a price changes
 * about never — so without this each of those visits spends an outbound Stripe
 * call on an answer that has not moved. Per-isolate and deliberately short:
 * long enough that a burst of page loads costs one call, short enough that a
 * price change in the Stripe dashboard is live within the hour rather than
 * needing a deploy to take effect.
 */
export const PRICE_CACHE_TTL_MS = 10 * 60 * 1000;

interface CachedPrice {
  price: StripePrice;
  readAt: number;
}

/**
 * Build a catalogue reader over a Stripe client and a price configuration.
 *
 * The cache lives on the returned reader rather than in module scope so tests
 * get a fresh one per construction, and so two configurations in one isolate
 * cannot read each other's entries.
 */
export function createUpgradeCatalogue(deps: {
  stripe: StripeClient;
  prices: UpgradePriceConfig;
  /** Injected so the TTL is testable without waiting. */
  now?: () => number;
}) {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, CachedPrice>();

  const priceFor = (priceId: string): Effect.Effect<StripePrice, StripeError> =>
    Effect.gen(function* () {
      const hit = cache.get(priceId);
      if (hit && now() - hit.readAt < PRICE_CACHE_TTL_MS) return hit.price;
      const price = yield* deps.stripe.retrievePrice(priceId);
      cache.set(priceId, { price, readAt: now() });
      return price;
    });

  const configured = (id: string | undefined): string | null => {
    const trimmed = id?.trim();
    return trimmed === undefined || trimmed === "" ? null : trimmed;
  };

  /**
   * The Price that moves a wedding on `from` to `tier`, or `null` when this
   * deployment does not sell that move. A wedding already on `tier` or above
   * it has nothing to buy, so that is `null` too.
   */
  const priceIdFor = (tier: PaidTier, from: Tier): string | null => {
    if (tierAtLeast(from, tier)) return null;
    if (tier === "gold") return configured(deps.prices.gold);
    return from === "gold"
      ? configured(deps.prices.crimsonFromGold)
      : configured(deps.prices.crimson);
  };

  /** The tiers a wedding on `from` can buy here, lowest first. */
  const sellable = (from: Tier): PaidTier[] =>
    PURCHASABLE_TIERS.filter((tier) => priceIdFor(tier, from) !== null);

  return {
    sellable,
    priceIdFor,

    /**
     * Every upgrade a wedding on `from` can buy, priced.
     *
     * A Price that Stripe refuses drops its entry rather than failing the whole
     * catalogue: one misconfigured Price must not take the other tier's offer
     * down with it. The refusal is the caller's to log.
     */
    list(from: Tier): Effect.Effect<CatalogueEntry[], never, never> {
      // Concurrent across tiers: each is a separate Stripe resource, so the
      // reads never had to chain. On a cold isolate a sequential loop makes the
      // dialog's "Checking the price…" state as long as the sum of them, and a
      // Worker gets new isolates continuously — the cache spares the second
      // request, never the first.
      //
      // `sellable()` yields distinct tiers, each with its own Price, so two
      // fibres cannot race the same `priceId` into the cache.
      const entryFor = (tier: PaidTier): Effect.Effect<CatalogueEntry | null, never, never> =>
        Effect.gen(function* () {
          const priceId = priceIdFor(tier, from);
          if (priceId === null) return null;
          const price = yield* Effect.result(priceFor(priceId));
          // A Price Stripe refuses drops its OWN entry and no other: one
          // misconfigured Price is an operator mistake, the whole upgrade
          // surface vanishing because of it is an outage.
          if (price._tag === "Failure") return null;
          return {
            tier,
            fromTier: from,
            ...COPY[tier],
            priceId,
            amountMinor: price.success.unitAmountMinor,
            currency: price.success.currency,
          };
        });

      return Effect.all(sellable(from).map(entryFor), { concurrency: "unbounded" }).pipe(
        Effect.map((entries) => entries.filter((e): e is CatalogueEntry => e !== null)),
        Effect.withSpan("cire.upgrade.catalogue"),
      );
    },
  };
}

export type UpgradeCatalogue = ReturnType<typeof createUpgradeCatalogue>;
