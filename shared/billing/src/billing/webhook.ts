/**
 * The provider webhook: verify, claim, re-fetch, store, apply.
 *
 * Status codes are instructions to Stripe, which retries any non-2xx for days:
 * 400 for a body that cannot be verified (a retry cannot fix it), 500 for a
 * failure a retry may fix (storage, provider, a busy lease, a failed hook),
 * 200 for everything else, including events this package does not act on.
 *
 * The event body is never trusted for state: the subscription is re-fetched,
 * and the fetch's start time guards the write so a slow fetch of older state
 * cannot overwrite a newer one. The one thing read from the body is an
 * invoice's paid period, which is final once Stripe calls the invoice paid.
 */

import { Effect } from "effect";

import { MAX_EVENT_BYTES, readBoundedText } from "../http/webhook-body";
import { metricTransition, metricWebhook, type WebhookOutcome } from "../metrics";
import { productIdFor } from "../plans";
import type { PaidPeriod, ProviderEvent, ProviderSubscription } from "../provider/port";
import type { EventOutcome } from "../storage/port";
import { applyAccess } from "./access";
import { after, type BillingContext } from "./context";
import type { WebhookResult } from "./types";

const result = (
  status: WebhookResult["status"],
  outcome: WebhookOutcome,
  reason?: string,
): WebhookResult => ({
  status,
  body: { received: status === 200, outcome, reason },
});

/** The plan a provider price belongs to: its `plan_id` metadata, else its product. Never its lookup key. */
export function planIdFor(ctx: BillingContext, sub: ProviderSubscription): string | null {
  if (sub.planIdMetadata !== null)
    return ctx.planById.has(sub.planIdMetadata) ? sub.planIdMetadata : null;
  return ctx.plans.find((plan) => productIdFor(plan.id) === sub.productId)?.id ?? null;
}

/**
 * Re-fetch one subscription and store it, then apply access. `fetchStartedAt`
 * is taken before the request goes out. Answers `ignored` for a subscription
 * that is not this package's to store.
 */
export const syncSubscription = (
  ctx: BillingContext,
  subscriptionId: string,
  paidPeriod: PaidPeriod | null,
) =>
  Effect.gen(function* () {
    const fetchStartedAt = ctx.now();
    const sub = yield* ctx.provider.retrieveSubscription(subscriptionId);
    if (sub === null) return "ignored" satisfies EventOutcome;
    const [customer, existing] = yield* Effect.all(
      [ctx.storage.findCustomerByProviderId(sub.customerId), ctx.storage.findSubscription(sub.id)],
      { concurrency: 2 },
    );
    // Not a customer this package made: another product on the account, or a
    // reset dev tier. A retry cannot change that.
    if (customer === null) return "ignored" satisfies EventOutcome;
    const planId = planIdFor(ctx, sub);
    if (planId === null) {
      yield* Effect.logWarning("billing: subscription price maps to no plan; not stored");
      return "ignored" satisfies EventOutcome;
    }
    const now = ctx.now();
    yield* ctx.storage.upsertSubscription(
      {
        providerSubscriptionId: sub.id,
        customerRef: customer.customerRef,
        planId,
        providerPriceId: sub.priceId,
        interval: sub.interval,
        status: sub.status,
        currency: sub.currency,
        currentPeriodStart: sub.currentPeriodStart,
        currentPeriodEnd: sub.currentPeriodEnd,
        trialEnd: sub.trialEnd,
        cancelAtPeriodEnd: sub.cancelAtPeriodEnd,
        fetchStartedAt,
      },
      now,
    );
    if (existing === null || existing.fetchStartedAt.getTime() <= fetchStartedAt.getTime()) {
      if ((existing?.status ?? null) !== sub.status)
        metricTransition(existing?.status ?? null, sub.status);
    }
    if (sub.trialEnd !== null) yield* ctx.storage.markTrialUsed(customer.id, now);
    if (paidPeriod !== null) {
      yield* ctx.storage.recordPaidPeriod({
        providerSubscriptionId: sub.id,
        customerRef: customer.customerRef,
        start: paidPeriod.start,
        end: paidPeriod.end,
        now,
      });
    }
    yield* applyAccess(ctx, customer.customerRef, "webhook", true);
    return "processed" satisfies EventOutcome;
  });

const process = (
  ctx: BillingContext,
  event: Exclude<ProviderEvent, { kind: "connect" | "ignored" }>,
) =>
  Effect.gen(function* () {
    switch (event.kind) {
      case "checkout_completed": {
        if (event.subscriptionId === null) return "ignored" satisfies EventOutcome;
        // The subscription first: until it is stored, the pending session is
        // what stops a second checkout in the group.
        const outcome = yield* syncSubscription(ctx, event.subscriptionId, null);
        const customer =
          event.customerId === null
            ? null
            : yield* ctx.storage.findCustomerByProviderId(event.customerId);
        if (customer !== null)
          yield* ctx.storage.clearCheckout({ customerId: customer.id, sessionId: event.sessionId });
        return outcome;
      }
      case "checkout_expired": {
        const customer =
          event.customerId === null
            ? null
            : yield* ctx.storage.findCustomerByProviderId(event.customerId);
        if (customer === null) return "ignored" satisfies EventOutcome;
        yield* ctx.storage.clearCheckout({ customerId: customer.id, sessionId: event.sessionId });
        return "processed" satisfies EventOutcome;
      }
      case "subscription": {
        return yield* syncSubscription(ctx, event.subscriptionId, null);
      }
      case "invoice_paid": {
        return yield* syncSubscription(ctx, event.subscriptionId, event.paidPeriod);
      }
    }
  });

export const handleWebhook = (
  ctx: BillingContext,
  request: Request,
): Effect.Effect<WebhookResult> =>
  Effect.suspend(() => {
    // Set once the event is verified; until then the delivery has no type worth a series.
    let eventType = "";
    return Effect.gen(function* () {
      const declared = Number.parseInt(request.headers.get("content-length") ?? "", 10);
      if (Number.isFinite(declared) && declared > MAX_EVENT_BYTES) return result(400, "too_large");
      const payload = yield* Effect.promise(() => readBoundedText(request, MAX_EVENT_BYTES));
      if (payload === null) return result(400, "too_large");

      const verified = yield* Effect.result(
        ctx.provider
          .verifyWebhook({ payload, headers: request.headers, now: ctx.now() })
          .pipe(Effect.withSpan("billing.webhook.verify")),
      );
      if (verified._tag === "Failure") {
        const error = verified.failure;
        if (error._tag === "WebhookSignatureError")
          return result(400, "invalid_signature", error.reason);
        yield* Effect.logError("billing: a verified event could not be read").pipe(
          Effect.annotateLogs({ reason: error.reason }),
        );
        return result(500, "error");
      }
      const event = verified.success;
      eventType = event.type;
      if (event.kind === "connect") return result(200, "refused_connect");
      if (event.kind === "ignored") return result(200, "ignored");
      if (event.kind === "checkout_completed" && event.mode !== "subscription")
        return result(200, "ignored");

      const now = ctx.now();
      const claim = yield* Effect.result(
        ctx.storage.claimEvent({
          eventId: event.id,
          type: event.type,
          now,
          leaseUntil: after(now, ctx.tuning.eventLeaseMs),
        }),
      );
      if (claim._tag === "Failure") {
        yield* Effect.logError("billing: could not claim a webhook event").pipe(
          Effect.annotateLogs({ operation: claim.failure.operation }),
        );
        return result(500, "error");
      }
      if (claim.success === "done") return result(200, "duplicate");
      if (claim.success === "held") return result(500, "lease_held");

      // `exit`, not `result`: a defect must free the claim as surely as a failure.
      const processed = yield* Effect.exit(
        process(ctx, event).pipe(Effect.withSpan("billing.webhook.apply")),
      );
      if (processed._tag === "Failure") {
        // Let the redelivery take the event at once rather than after the lease.
        yield* ctx.storage.releaseEvent(event.id).pipe(Effect.ignore);
        yield* Effect.logError(
          "billing: webhook event failed; Stripe will redeliver",
          processed.cause,
        );
        return result(500, "error");
      }
      const finished = yield* Effect.result(ctx.storage.finishEvent(event.id, processed.value));
      if (finished._tag === "Failure") return result(500, "error");
      return result(200, processed.value);
    }).pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("billing: webhook defect", defect).pipe(Effect.as(result(500, "error"))),
      ),
      Effect.tap((r) => Effect.sync(() => metricWebhook(eventType, r.body.outcome))),
      Effect.withSpan("billing.webhook.handle"),
    );
  });
