/**
 * The same billing instance for an app that does not use Effect: every method
 * returns a Promise, and `onAccess` may return one.
 *
 * `run` is required, and should be the consumer's own runtime's `runPromise`
 * (`ManagedRuntime.runPromise`, or a wrapper like Cire's `runCire`): it carries
 * the logger that redacts, and the tracer. A rejection is the tagged error
 * itself (`_tag`), as Effect v4's `runPromise` rejects with.
 */

import { Effect } from "effect";

import { createBilling as createEffectBilling } from "./billing";
import type {
  AccessDecision,
  AccessHookContext,
  BillingOptions,
  BillingStatus,
  CatalogueEntry,
  CheckoutInput,
  GrantInput,
  ReapplyReport,
  ReconcileReport,
  SweepReport,
  WebhookResult,
} from "./billing/types";
import type { AnyPlan, FeatureIdOf, PlanIdOf } from "./plans";
import type { FeatureAccess } from "./policy";

export type Runner = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** {@link import("./billing/types").Billing}, method for method, as Promises. */
export interface PromiseBilling<PlanId extends string, FeatureId extends string> {
  checkout(
    input: CheckoutInput<PlanId>,
  ): Promise<{ readonly url: string; readonly reused: boolean }>;
  portal(input: {
    readonly customerRef: string;
    readonly returnUrl: string;
  }): Promise<{ readonly url: string }>;
  catalogue(): Promise<readonly CatalogueEntry<PlanId>[]>;
  check(customerRef: string, featureId: FeatureId): Promise<FeatureAccess>;
  status(customerRef: string): Promise<BillingStatus<PlanId, FeatureId>>;
  handleWebhook(request: Request): Promise<WebhookResult>;
  grant(input: GrantInput<FeatureId>): Promise<void>;
  revokeGrant(input: {
    readonly customerRef: string;
    readonly featureId: FeatureId;
  }): Promise<boolean>;
  reconcile(input: { readonly limit: number }): Promise<ReconcileReport>;
  sweepAccess(input: { readonly limit: number }): Promise<SweepReport>;
  reapplyAll(input: { readonly customerRefs: readonly string[] }): Promise<ReapplyReport>;
  pruneWebhookEvents(input: { readonly before: Date }): Promise<number>;
}

export interface PromiseBillingOptions<Plans extends readonly AnyPlan[]> extends Omit<
  BillingOptions<Plans>,
  "hooks"
> {
  readonly run: Runner;
  readonly hooks?: {
    readonly onAccess?: (
      decision: AccessDecision<FeatureIdOf<Plans>, PlanIdOf<Plans>>,
      context: AccessHookContext,
    ) => Promise<void>;
  };
}

export function createBilling<const Plans extends readonly AnyPlan[]>(
  options: PromiseBillingOptions<Plans>,
): PromiseBilling<PlanIdOf<Plans>, FeatureIdOf<Plans>> {
  const { run, hooks, ...rest } = options;
  const onAccess = hooks?.onAccess;
  const billing = createEffectBilling({
    ...rest,
    hooks: {
      onAccess:
        onAccess &&
        ((decision, context) =>
          Effect.tryPromise({ try: () => onAccess(decision, context), catch: (cause) => cause })),
    },
  });
  return {
    checkout: (input) => run(billing.checkout(input)),
    portal: (input) => run(billing.portal(input)),
    catalogue: () => run(billing.catalogue()),
    check: (customerRef, featureId) => run(billing.check(customerRef, featureId)),
    status: (customerRef) => run(billing.status(customerRef)),
    handleWebhook: (request) => run(billing.handleWebhook(request)),
    grant: (input) => run(billing.grant(input)),
    revokeGrant: (input) => run(billing.revokeGrant(input)),
    reconcile: (input) => run(billing.reconcile(input)),
    sweepAccess: (input) => run(billing.sweepAccess(input)),
    reapplyAll: (input) => run(billing.reapplyAll(input)),
    pruneWebhookEvents: (input) => run(billing.pruneWebhookEvents(input)),
  };
}
