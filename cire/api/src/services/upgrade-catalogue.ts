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
 * `@shared/turnstile`: a key with no configured Price id is simply not
 * purchasable. It never appears in the catalogue and the checkout route 404s
 * for it. Absent configuration means no payment surface — never "free".
 */

import { Effect } from "effect";

import { type StripeClient, StripeError, type StripePrice } from "./stripe";

/**
 * The keys sold self-serve today.
 *
 * `premium_templates` and `ai` have no finished module behind them, and the two
 * `capacity_*` keys are derived rather than a module unlock (`deriveCap`), so
 * they want their own prompt at the point an import hits the ceiling rather
 * than a nav-row upgrade. Adding to this list plus a Price id is the whole
 * change needed to sell another.
 */
export const PURCHASABLE_ENTITLEMENTS = ["vendors", "registry"] as const;
export type PurchasableEntitlement = (typeof PURCHASABLE_ENTITLEMENTS)[number];

export function isPurchasable(key: string): key is PurchasableEntitlement {
  // `Object.hasOwn`-style membership on a closed list: `includes` on a
  // readonly tuple is the array equivalent and walks no prototype chain.
  return (PURCHASABLE_ENTITLEMENTS as readonly string[]).includes(key);
}

/** The copy shown on the upgrade dialog. Not in the database: it is product
 *  writing that ships with the release, and a row would only let it drift from
 *  the module it describes. */
const COPY = {
  vendors: {
    title: "Vendors & directory",
    blurb: "Browse trusted wedding vendors and manage your shortlist in one place.",
  },
  registry: {
    title: "Gift registry",
    blurb: "List the gifts you'd like, and see what guests have claimed and sent.",
  },
} satisfies Record<PurchasableEntitlement, { title: string; blurb: string }>;

/** Stripe Price ids, one per purchasable key. A key absent here is not for
 *  sale in this deployment. */
export type UpgradePriceConfig = Partial<Record<PurchasableEntitlement, string>>;

/** One sellable upgrade, priced. */
export interface CatalogueEntry {
  entitlement: PurchasableEntitlement;
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

  const sellable = (): PurchasableEntitlement[] =>
    PURCHASABLE_ENTITLEMENTS.filter((key) => priceIdFor(key) !== null);

  const priceIdFor = (key: PurchasableEntitlement): string | null => {
    const id = deps.prices[key]?.trim();
    return id === undefined || id === "" ? null : id;
  };

  return {
    /** The keys this deployment can actually sell. */
    sellable,
    /** The Price id for a key, or `null` when it is not for sale here. */
    priceIdFor,

    /**
     * Every sellable upgrade, priced.
     *
     * A Price that Stripe refuses drops its entry rather than failing the whole
     * catalogue: one misconfigured key must not take the other module's upgrade
     * offer down with it. The refusal is the caller's to log.
     */
    list(): Effect.Effect<CatalogueEntry[], never, never> {
      // Concurrent across keys: each is a separate Stripe resource, so the
      // reads never had to chain. On a cold isolate a sequential loop makes the
      // dialog's "Checking the price…" state as long as the sum of them, and a
      // Worker gets new isolates continuously — the cache spares the second
      // request, never the first.
      //
      // `sellable()` yields distinct keys, so two fibres cannot race the same
      // `priceId` into the cache.
      const entryFor = (
        entitlement: PurchasableEntitlement,
      ): Effect.Effect<CatalogueEntry | null, never, never> =>
        Effect.gen(function* () {
          const priceId = priceIdFor(entitlement);
          if (priceId === null) return null;
          const price = yield* Effect.result(priceFor(priceId));
          // A Price Stripe refuses drops its OWN entry and no other: one
          // misconfigured key is an operator mistake, the whole upgrade surface
          // vanishing because of it is an outage.
          if (price._tag === "Failure") return null;
          return {
            entitlement,
            ...COPY[entitlement],
            priceId,
            amountMinor: price.success.unitAmountMinor,
            currency: price.success.currency,
          };
        });

      return Effect.all(sellable().map(entryFor), { concurrency: "unbounded" }).pipe(
        Effect.map((entries) => entries.filter((e): e is CatalogueEntry => e !== null)),
        Effect.withSpan("cire.upgrade.catalogue"),
      );
    },
  };
}

export type UpgradeCatalogue = ReturnType<typeof createUpgradeCatalogue>;
