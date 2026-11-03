/**
 * `@shared/billing`: code-defined plans, subscriptions and feature access for
 * Workers, with Stripe as the provider and Drizzle on SQLite as the store.
 *
 * Entry points: this module (the Effect API), `./promise`, `./stripe`,
 * `./storage/sqlite-schema`, `./storage/sqlite`, `./webhook-body`, `./elysia`,
 * `./sync`. See wiki/shared/billing.md.
 */

export { createBilling } from "./billing";
export {
  DEFAULT_TUNING,
  type AccessDecision,
  type AccessHookContext,
  type Billing,
  type BillingHooks,
  type BillingOptions,
  type BillingStatus,
  type CatalogueEntry,
  type CheckoutError,
  type CheckoutInput,
  type GrantInput,
  type GrantStatus,
  type PaidPeriodStatus,
  type ReapplyReport,
  type ReconcileReport,
  type SubscriptionStatus,
  type SweepReport,
  type Tuning,
  type WebhookResult,
} from "./billing/types";
export * from "./errors";
export {
  defineFeature,
  definePlan,
  productIdFor,
  type AnyPlan,
  type BillingInterval,
  type Feature,
  type FeatureIdOf,
  type Plan,
  type PlanIdOf,
  type PlanPrice,
  type TaxBehavior,
} from "./plans";
export { DEFAULT_POLICY, type AccessPolicy, type AccessReason, type FeatureAccess } from "./policy";
export type { BillingProvider, ProviderEvent, TaxOptions } from "./provider/port";
export type { BillingStorage } from "./storage/port";
export { BILLING_METRICS } from "./metrics";
