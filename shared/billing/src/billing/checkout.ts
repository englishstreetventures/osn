/**
 * Subscription checkout, the billing portal, and the price catalogue.
 *
 * At most one checkout is pending per customer. Its plan, currency and a nonce
 * live on the customer row; the nonce is in the Checkout idempotency key, so
 * every request working on one pending checkout reaches the same Stripe
 * session, and a new nonce is what makes a new session.
 */

import { Duration, Effect } from "effect";

import {
  AlreadySubscribed,
  CheckoutInFlight,
  CurrencyNotOffered,
  NoBillingCustomer,
  PlanUnavailable,
  UnknownPlan,
  type BillingProviderError,
  type BillingStorageError,
} from "../errors";
import { metricCheckout, metricPortal, type CheckoutOutcome } from "../metrics";
import { productIdFor, type AnyPlan } from "../plans";
import { isTerminalStatus } from "../policy";
import type { ProviderPrice } from "../provider/port";
import type { CustomerRecord } from "../storage/port";
import type { BillingContext } from "./context";
import type { CatalogueEntry, CheckoutError, CheckoutInput } from "./types";

const CUSTOMER_CREATE_ATTEMPTS = 3;
const newNonce = () => crypto.randomUUID().replaceAll("-", "");

/**
 * The catalogue, cached per billing instance in a plain value with a TTL. Not
 * an `Effect.cached` or any other waiting primitive: a request woken by
 * another request's fiber would run on that request's D1 session
 * (cire/api/src/db/d1-session.ts). Two cold requests both fetch; that is all.
 */
export function createCatalogue(ctx: BillingContext) {
  let cached: { readonly at: number; readonly entries: readonly CatalogueEntry[] } | null = null;

  const entryFor = (plan: AnyPlan, price: ProviderPrice | undefined): CatalogueEntry => {
    const named = price?.planIdMetadata ?? null;
    const ours =
      price !== undefined &&
      (named === plan.id || (named === null && price.productId === productIdFor(plan.id)));
    if (!price || !ours) {
      return {
        planId: plan.id,
        name: plan.name,
        group: plan.group,
        lookupKey: plan.lookupKey,
        available: false,
        priceId: price?.id ?? null,
        interval: null,
        taxBehavior: null,
        defaultCurrency: null,
        prices: [],
      };
    }
    return {
      planId: plan.id,
      name: plan.name,
      group: plan.group,
      lookupKey: plan.lookupKey,
      available: true,
      priceId: price.id,
      interval: price.interval,
      taxBehavior: price.taxBehavior,
      defaultCurrency: price.currency,
      prices: [
        { currency: price.currency, unitAmount: price.unitAmount },
        ...Object.entries(price.currencyOptions).map(([currency, option]) => ({
          currency,
          unitAmount: option.unitAmount,
        })),
      ],
    };
  };

  const catalogue = (): Effect.Effect<readonly CatalogueEntry[], BillingProviderError> =>
    Effect.suspend(() => {
      const nowMs = ctx.now().getTime();
      if (cached !== null && nowMs - cached.at < ctx.tuning.catalogueTtlMs) {
        return Effect.succeed(cached.entries);
      }
      return ctx.provider.listPrices(ctx.plans.map((plan) => plan.lookupKey)).pipe(
        Effect.map((prices) => {
          const byKey = new Map(prices.filter((p) => p.active).map((p) => [p.lookupKey, p]));
          const entries = ctx.plans.map((plan) => entryFor(plan, byKey.get(plan.lookupKey)));
          cached = { at: nowMs, entries };
          return entries;
        }),
      );
    }).pipe(Effect.withSpan("billing.catalogue"));

  return catalogue;
}

export function createCheckout(ctx: BillingContext, catalogue: ReturnType<typeof createCatalogue>) {
  const { storage, provider, tuning } = ctx;

  /** The Stripe customer, created once. A 409 is the same key still in flight: replay it. */
  const ensureProviderCustomer = (customer: CustomerRecord) =>
    Effect.gen(function* () {
      if (customer.providerCustomerId !== null) return customer.providerCustomerId;
      const create = provider.createCustomer({
        billingCustomerId: customer.id,
        idempotencyKey: `billing-customer-${customer.id}`,
      });
      let created: { readonly id: string } | null = null;
      for (let attempt = 1; created === null; attempt += 1) {
        const result = yield* Effect.result(create);
        if (result._tag === "Success") created = result.success;
        else if (result.failure.status === 409 && attempt < CUSTOMER_CREATE_ATTEMPTS) {
          yield* Effect.sleep(Duration.millis(tuning.customerRetryMs));
        } else return yield* Effect.fail(result.failure);
      }
      if (yield* storage.setProviderCustomerId(customer.id, created.id)) return created.id;
      const winner = yield* storage.findCustomer(customer.customerRef);
      return winner?.providerCustomerId ?? created.id;
    });

  const trialDaysFor = (plan: AnyPlan, customer: CustomerRecord) =>
    (plan.trialDays ?? 0) > 0 && (!ctx.policy.oneTrialPerCustomer || customer.trialUsedAt === null)
      ? (plan.trialDays ?? null)
      : null;

  const checkout = (
    input: CheckoutInput<string>,
  ): Effect.Effect<{ url: string; reused: boolean }, CheckoutError> =>
    Effect.gen(function* () {
      const plan = ctx.planById.get(input.planId);
      if (!plan) return yield* Effect.fail(new UnknownPlan({ planId: input.planId }));
      const currency = input.currency.toUpperCase();
      const started = ctx.now();
      const customer0 = yield* storage.ensureCustomer(input.customerRef, started);

      const subscriptions = yield* storage.listSubscriptions(input.customerRef);
      const live = subscriptions.some(
        (s) => ctx.planById.get(s.planId)?.group === plan.group && !isTerminalStatus(s.status),
      );
      if (live) return yield* Effect.fail(new AlreadySubscribed({ group: plan.group }));

      const entry = (yield* catalogue()).find((e) => e.planId === plan.id);
      if (!entry?.available || entry.priceId === null) {
        return yield* Effect.fail(
          new PlanUnavailable({
            planId: plan.id,
            reason: entry?.priceId ? "mismatched" : "missing",
          }),
        );
      }
      const priceId = entry.priceId;
      if (!entry.prices.some((p) => p.currency === currency)) {
        return yield* Effect.fail(new CurrencyNotOffered({ planId: plan.id, currency }));
      }

      const providerCustomerId = yield* ensureProviderCustomer(customer0);
      const matches = (pending: { planId: string; currency: string }) =>
        pending.planId === plan.id && pending.currency === currency;

      /** Create the session for a nonce this request holds. */
      const create = (customer: CustomerRecord, nonce: string) =>
        Effect.gen(function* () {
          const session = yield* provider
            .createSubscriptionCheckout({
              customerId: providerCustomerId,
              priceId,
              currency,
              successUrl: input.successUrl,
              cancelUrl: input.cancelUrl,
              clientReferenceId: customer.id,
              trialDays: trialDaysFor(plan, customer),
              tax: ctx.tax,
              idempotencyKey: `billing-checkout-${customer.id}-${nonce}`,
            })
            .pipe(
              Effect.tapError(() => storage.abandonCheckout({ customerId: customer.id, nonce })),
            );
          if (
            yield* storage.setCheckoutSession({
              customerId: customer.id,
              nonce,
              sessionId: session.id,
            })
          ) {
            return { url: session.url, reused: false };
          }
          // Another request replaced this checkout while the session was made.
          // Nobody tracks this session, so nobody may pay it.
          yield* provider.expireCheckoutSession(session.id).pipe(Effect.ignore);
          return yield* Effect.fail(new CheckoutInFlight());
        });

      /** Replace the pending checkout (whose nonce was `expected`) with one of ours. */
      const replace = (customer: CustomerRecord, expected: string | null) =>
        Effect.gen(function* () {
          const nonce = newNonce();
          const won = yield* storage.claimCheckout({
            customerId: customer.id,
            expectedNonce: expected,
            nonce,
            planId: plan.id,
            currency,
            now: ctx.now(),
          });
          return won ? nonce : null;
        });

      const deadline = performance.now() + tuning.checkoutWaitMs;
      let customer = customer0;
      for (;;) {
        const pending = customer.pendingCheckout;
        if (pending === null) {
          const nonce = yield* replace(customer, null);
          if (nonce !== null) return yield* create(customer, nonce);
        } else if (pending.sessionId !== null) {
          const session = yield* provider.retrieveCheckoutSession(pending.sessionId);
          if (session.status === "complete") return yield* Effect.fail(new CheckoutInFlight());
          if (session.status === "open" && session.url !== null && matches(pending)) {
            return { url: session.url, reused: true };
          }
          // Claim first, then expire: a late `expired` webhook clears by session
          // id, so it cannot clear the checkout that replaces this one.
          const nonce = yield* replace(customer, pending.nonce);
          if (nonce !== null) {
            if (session.status === "open") {
              const expired = yield* Effect.result(provider.expireCheckoutSession(session.id));
              if (expired._tag === "Failure") {
                const now = yield* provider.retrieveCheckoutSession(session.id);
                if (now.status !== "expired") {
                  // It completed under us: the buyer has paid and the webhook is
                  // coming. Put the paid session back, so every request until
                  // then sees it complete rather than a free slot.
                  yield* storage.abandonCheckout({
                    customerId: customer.id,
                    nonce,
                    restore: pending,
                  });
                  return yield* Effect.fail(new CheckoutInFlight());
                }
              }
            }
            return yield* create(customer, nonce);
          }
        } else if (ctx.now().getTime() - pending.startedAt.getTime() > tuning.pendingStaleMs) {
          // A request claimed this and never recorded a session; it is gone.
          const nonce = yield* replace(customer, pending.nonce);
          if (nonce !== null) return yield* create(customer, nonce);
        } else if (!matches(pending)) {
          return yield* Effect.fail(new CheckoutInFlight());
        }
        // Another request is creating this checkout: wait for its session.
        if (performance.now() >= deadline) return yield* Effect.fail(new CheckoutInFlight());
        yield* Effect.sleep(Duration.millis(tuning.checkoutPollMs));
        customer = (yield* storage.findCustomer(input.customerRef)) ?? customer;
      }
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => metricCheckout(result.reused ? "reused" : "created")),
      ),
      Effect.tapError((error) => Effect.sync(() => metricCheckout(checkoutOutcome(error)))),
      Effect.withSpan("billing.checkout"),
    );

  const portal = (input: {
    customerRef: string;
    returnUrl: string;
  }): Effect.Effect<
    { url: string },
    NoBillingCustomer | BillingStorageError | BillingProviderError
  > =>
    Effect.gen(function* () {
      const customer = yield* storage.findCustomer(input.customerRef);
      if (customer?.providerCustomerId == null) return yield* Effect.fail(new NoBillingCustomer());
      return yield* provider.createPortalSession({
        customerId: customer.providerCustomerId,
        returnUrl: input.returnUrl,
        configuration: ctx.portalConfiguration,
      });
    }).pipe(
      Effect.tap(() => Effect.sync(() => metricPortal("opened"))),
      Effect.tapError((error) =>
        Effect.sync(() =>
          metricPortal(error._tag === "NoBillingCustomer" ? "no_customer" : "error"),
        ),
      ),
      Effect.withSpan("billing.portal"),
    );

  return { checkout, portal };
}

const checkoutOutcome = (error: CheckoutError): CheckoutOutcome => {
  switch (error._tag) {
    case "AlreadySubscribed": {
      return "already_subscribed";
    }
    case "CheckoutInFlight": {
      return "in_flight";
    }
    case "CurrencyNotOffered": {
      return "currency_not_offered";
    }
    case "PlanUnavailable":
    case "UnknownPlan": {
      return "plan_unavailable";
    }
    default: {
      return "error";
    }
  }
};
