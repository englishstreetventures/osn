import { Effect } from "effect";

import { UnknownFeature } from "../errors";
import { metricAccessChecked } from "../metrics";
import { assertDistinctPlans, type AnyPlan, type FeatureIdOf, type PlanIdOf } from "../plans";
import { decideFeature } from "../policy";
import { applyAccess, decideStatus, forgetCustomer, readState } from "./access";
import { createCatalogue, createCheckout } from "./checkout";
import { createContext, type BillingContext } from "./context";
import { reapplyAll, reconcile, sweepAccess } from "./cron";
import type { Billing, BillingOptions } from "./types";
import { handleWebhook } from "./webhook";

/**
 * A billing instance. Build it once per isolate (or process) and share it:
 * the catalogue cache lives on it. Every method returns an Effect that needs
 * no services, so it runs on the consumer's own `ManagedRuntime`.
 */
export function createBilling<const Plans extends readonly AnyPlan[]>(
  options: BillingOptions<Plans>,
): Billing<PlanIdOf<Plans>, FeatureIdOf<Plans>> {
  assertDistinctPlans(options.plans);
  const ctx: BillingContext = createContext({
    plans: options.plans,
    storage: options.storage,
    provider: options.provider,
    policy: options.policy,
    tax: options.tax,
    tuning: options.tuning,
    returnOrigins: options.returnOrigins,
    portalConfiguration: options.portalConfiguration,
    now: options.now,
    onAccess: options.hooks?.onAccess as BillingContext["onAccess"],
  });
  const catalogue = createCatalogue(ctx);
  const { checkout, portal } = createCheckout(ctx, catalogue);

  const knownFeature = (featureId: string) =>
    ctx.featureIds.includes(featureId)
      ? Effect.void
      : Effect.fail(new UnknownFeature({ featureId }));

  const billing: Billing<string, string> = {
    checkout,
    portal,
    catalogue,

    check: (customerRef, featureId) =>
      Effect.gen(function* () {
        yield* knownFeature(featureId);
        const [rows, grants] = yield* readState(ctx, customerRef);
        const status = yield* decideStatus(ctx, customerRef, rows, grants, ctx.now());
        return (
          status.features[featureId] ??
          decideFeature({
            featureId,
            subscriptions: [],
            grants: [],
            policy: ctx.policy,
            now: ctx.now(),
          })
        );
      }).pipe(
        Effect.tap((access) =>
          Effect.sync(() => metricAccessChecked(access.reason, access.allowed)),
        ),
        Effect.withSpan("billing.check"),
      ),

    status: (customerRef) =>
      readState(ctx, customerRef).pipe(
        Effect.flatMap(([rows, grants]) => decideStatus(ctx, customerRef, rows, grants, ctx.now())),
        Effect.withSpan("billing.status"),
      ),

    handleWebhook: (request) => handleWebhook(ctx, request),

    grant: (input) =>
      Effect.gen(function* () {
        yield* knownFeature(input.featureId);
        const now = ctx.now();
        // A grant needs a customer row, so it has a boundary the sweep can see.
        yield* ctx.storage.ensureCustomer(input.customerRef, now);
        yield* ctx.storage.upsertGrant(
          {
            customerRef: input.customerRef,
            featureId: input.featureId,
            source: input.source,
            grantedBy: input.grantedBy,
            expiresAt: input.expiresAt,
          },
          now,
        );
        yield* applyAccess(ctx, input.customerRef, "grant", "write");
      }).pipe(Effect.withSpan("billing.grant")),

    revokeGrant: (input) =>
      Effect.gen(function* () {
        yield* knownFeature(input.featureId);
        const now = ctx.now();
        yield* ctx.storage.ensureCustomer(input.customerRef, now);
        const existed = yield* ctx.storage.deleteGrant(input.customerRef, input.featureId, now);
        yield* applyAccess(ctx, input.customerRef, "grant", "write");
        return existed;
      }).pipe(Effect.withSpan("billing.revoke_grant")),

    reconcile: (input) => reconcile(ctx, input.limit),
    sweepAccess: (input) => sweepAccess(ctx, input.limit),
    reapplyAll: (input) => reapplyAll(ctx, input.customerRefs),
    pruneWebhookEvents: (input) =>
      ctx.storage.pruneEvents(input.before).pipe(Effect.withSpan("billing.prune_webhook_events")),

    forgetCustomer: (input) => forgetCustomer(ctx, input.customerRef),
  };
  return billing as Billing<PlanIdOf<Plans>, FeatureIdOf<Plans>>;
}
