import type { Effect } from "effect";

import type {
  AccessBusy,
  AccessHookError,
  AlreadySubscribed,
  BillingProviderError,
  BillingStorageError,
  CheckoutInFlight,
  CurrencyNotOffered,
  NoBillingCustomer,
  PlanUnavailable,
  ReturnUrlRefused,
  UnknownFeature,
  UnknownPlan,
} from "../errors";
import type { WebhookOutcome } from "../metrics";
import type { AnyPlan, FeatureIdOf, PlanIdOf } from "../plans";
import type { AccessPolicy, FeatureAccess } from "../policy";
import type { BillingProvider, TaxOptions } from "../provider/port";
import type { BillingStorage } from "../storage/port";

/**
 * Timings, with defaults sized to fit a webhook inside Stripe's 20 s. Every
 * value is a finite number above zero, and `createBilling` throws unless
 * `leaseMs` exceeds `hookTimeoutMs + accessBudgetMs` and `eventLeaseMs` exceeds
 * that plus one provider call (`BillingProvider.callTimeoutMs`).
 */
export interface Tuning {
  /** How long an access lease lasts. Longer than the hook timeout plus the budget. */
  readonly leaseMs: number;
  /** The most `onAccess` may take. */
  readonly hookTimeoutMs: number;
  /** How long one call keeps trying to apply access (lease busy, or written under). */
  readonly accessBudgetMs: number;
  readonly backoffMs: number;
  /** How long a webhook claim holds an event. Longer than the slowest delivery. */
  readonly eventLeaseMs: number;
  /** How long a checkout waits for another request's session; covers a Stripe call. */
  readonly checkoutWaitMs: number;
  readonly checkoutPollMs: number;
  /** A pending checkout with no session after this long is abandoned. */
  readonly pendingStaleMs: number;
  /** Wait before replaying a customer create Stripe answered 409 (key in use). */
  readonly customerRetryMs: number;
  readonly catalogueTtlMs: number;
  /** A subscription reconcile attempted inside this is skipped. */
  readonly reconcileRetryMs: number;
  /** Case (b): an unconfirmed active period older than the first, younger than the second. */
  readonly unconfirmedMinAgeMs: number;
  readonly unconfirmedMaxAgeMs: number;
}

export const DEFAULT_TUNING: Tuning = {
  leaseMs: 30_000,
  hookTimeoutMs: 3_000,
  accessBudgetMs: 3_000,
  backoffMs: 100,
  eventLeaseMs: 60_000,
  checkoutWaitMs: 11_000,
  checkoutPollMs: 250,
  pendingStaleMs: 60_000,
  customerRetryMs: 250,
  catalogueTtlMs: 5 * 60_000,
  reconcileRetryMs: 60 * 60_000,
  unconfirmedMinAgeMs: 2 * 60 * 60_000,
  unconfirmedMaxAgeMs: 7 * 24 * 60 * 60_000,
};

export interface PaidPeriodStatus {
  /** `<subscription id>:<period start, unix seconds>` — stable across invoices for one period. */
  readonly id: string;
  readonly start: Date;
  readonly end: Date;
}

export interface SubscriptionStatus<PlanId extends string = string> {
  /** The provider's subscription id. */
  readonly subscriptionId: string;
  readonly planId: PlanId;
  readonly group: string | null;
  /** The provider's status string, as stored. */
  readonly status: string;
  /** The price's recurring interval as the provider reports it (`month`, `year`). */
  readonly interval: string | null;
  readonly currency: string;
  readonly currentPeriod: { readonly start: Date; readonly end: Date } | null;
  readonly trialEnd: Date | null;
  readonly cancelAtPeriodEnd: boolean;
  readonly pastDueSince: Date | null;
  /**
   * The latest period an invoice confirmed paid. Never a trial (its invoice
   * line is 0), never a renewal whose invoice has not been paid yet.
   */
  readonly paidPeriod: PaidPeriodStatus | null;
  /** `paidPeriod` is the current period. False during a trial and an unpaid renewal. */
  readonly currentPeriodPaid: boolean;
}

export interface GrantStatus<FeatureId extends string = string> {
  readonly featureId: FeatureId;
  readonly source: "comp";
  readonly grantedBy: string;
  readonly expiresAt: Date | null;
}

export interface BillingStatus<PlanId extends string = string, FeatureId extends string = string> {
  readonly customerRef: string;
  readonly subscriptions: readonly SubscriptionStatus<PlanId>[];
  readonly grants: readonly GrantStatus<FeatureId>[];
  readonly features: Readonly<Record<FeatureId, FeatureAccess>>;
}

/** What `onAccess` is handed: the CURRENT answer for every feature, never a delta. */
export interface AccessDecision<
  FeatureId extends string = string,
  PlanId extends string = string,
> extends BillingStatus<PlanId, FeatureId> {
  /**
   * A fencing token: every call to the hook carries a larger one than the call
   * before it, including a call that only time changed (a grant expiring, grace
   * running out). Store it with what the hook writes, and write only when it is
   * greater than the stored one (`WHERE applied_version < :version`), when the
   * order of two calls matters.
   */
  readonly version: number;
  readonly decidedAt: Date;
}

export interface AccessHookContext {
  /** Aborted when the hook runs past its timeout. */
  readonly signal: AbortSignal;
}

export interface BillingHooks<FeatureId extends string, PlanId extends string> {
  /** Idempotent: called with the current decision on every write and every sweep visit. */
  readonly onAccess?: (
    decision: AccessDecision<FeatureId, PlanId>,
    context: AccessHookContext,
  ) => Effect.Effect<void, unknown>;
}

export interface BillingOptions<Plans extends readonly AnyPlan[]> {
  readonly plans: Plans;
  readonly storage: BillingStorage;
  readonly provider: BillingProvider;
  readonly policy?: Partial<AccessPolicy>;
  /**
   * The origins a Checkout success or cancel URL and a portal return URL may
   * point at, such as `["https://app.example.com"]`. Any other URL is refused
   * with `ReturnUrlRefused` before Stripe is called.
   */
  readonly returnOrigins: readonly string[];
  readonly tax?: TaxOptions;
  readonly hooks?: BillingHooks<FeatureIdOf<Plans>, PlanIdOf<Plans>>;
  readonly now?: () => Date;
  /** The portal configuration id `syncPlans` printed; Stripe's default when omitted. */
  readonly portalConfiguration?: string;
  readonly tuning?: Partial<Tuning>;
}

export interface CatalogueEntry<PlanId extends string = string> {
  readonly planId: PlanId;
  readonly name: string;
  readonly group: string;
  readonly lookupKey: string;
  /** False when Stripe has no active price under the lookup key, or it names another plan. */
  readonly available: boolean;
  readonly priceId: string | null;
  readonly interval: string | null;
  /** Read from the Stripe price, never configured at run time. */
  readonly taxBehavior: string | null;
  readonly defaultCurrency: string | null;
  readonly prices: readonly { readonly currency: string; readonly unitAmount: number | null }[];
}

export interface WebhookResult {
  readonly status: 200 | 400 | 500;
  readonly body: {
    readonly received: boolean;
    readonly outcome: WebhookOutcome;
    readonly reason?: string;
  };
}

export interface CheckoutInput<PlanId extends string> {
  readonly customerRef: string;
  readonly planId: PlanId;
  /** ISO 4217, either case. The buyer pays in exactly this currency. */
  readonly currency: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

export interface GrantInput<FeatureId extends string> {
  readonly customerRef: string;
  readonly featureId: FeatureId;
  readonly source: "comp";
  readonly grantedBy: string;
  /** `null` is a grant with no expiry. */
  readonly expiresAt: Date | null;
}

export interface SweepReport {
  readonly visited: number;
  readonly applied: number;
  readonly busy: number;
  readonly failed: number;
}
export interface ReconcileReport {
  readonly selected: number;
  readonly refreshed: number;
  readonly missing: number;
  readonly failed: number;
}
export interface ReapplyReport {
  readonly applied: number;
  /** The refs whose application failed; retry them. */
  readonly failed: readonly string[];
}

export type CheckoutError =
  | UnknownPlan
  | PlanUnavailable
  | CurrencyNotOffered
  | AlreadySubscribed
  | CheckoutInFlight
  | ReturnUrlRefused
  | BillingStorageError
  | BillingProviderError;

export type PortalError =
  | NoBillingCustomer
  | ReturnUrlRefused
  | BillingStorageError
  | BillingProviderError;

export type ApplyError = AccessBusy | AccessHookError | BillingStorageError;

export interface Billing<PlanId extends string, FeatureId extends string> {
  checkout(
    input: CheckoutInput<PlanId>,
  ): Effect.Effect<{ readonly url: string; readonly reused: boolean }, CheckoutError>;
  portal(input: {
    readonly customerRef: string;
    readonly returnUrl: string;
  }): Effect.Effect<{ readonly url: string }, PortalError>;
  /** Every plan with its amounts, currencies and tax behaviour as Stripe has them. Cached. */
  catalogue(): Effect.Effect<readonly CatalogueEntry<PlanId>[], BillingProviderError>;
  /** Database only. */
  check(
    customerRef: string,
    featureId: FeatureId,
  ): Effect.Effect<FeatureAccess, UnknownFeature | BillingStorageError>;
  /** Database only. */
  status(customerRef: string): Effect.Effect<BillingStatus<PlanId, FeatureId>, BillingStorageError>;
  /** Never fails: every outcome is a status code Stripe acts on. */
  handleWebhook(request: Request): Effect.Effect<WebhookResult>;
  grant(input: GrantInput<FeatureId>): Effect.Effect<void, UnknownFeature | ApplyError>;
  revokeGrant(input: {
    readonly customerRef: string;
    readonly featureId: FeatureId;
  }): Effect.Effect<boolean, UnknownFeature | ApplyError>;
  /** Cron, before `sweepAccess`: re-fetch subscriptions whose stored state may be stale. */
  reconcile(input: { readonly limit: number }): Effect.Effect<ReconcileReport, BillingStorageError>;
  /** Cron, after `reconcile`: re-apply access for customers whose boundary has passed. */
  sweepAccess(input: { readonly limit: number }): Effect.Effect<SweepReport, BillingStorageError>;
  /** One-shot: apply the current decision to each ref, creating rows as needed. */
  reapplyAll(input: { readonly customerRefs: readonly string[] }): Effect.Effect<ReapplyReport>;
  /** Deletes webhook event claims received before `before`. */
  pruneWebhookEvents(input: { readonly before: Date }): Effect.Effect<number, BillingStorageError>;
  /**
   * Erasure: deletes the customer's grants, subscriptions and customer row in
   * one batch, and calls no hook. Answers the Stripe customer id it held, so the
   * consumer can delete that customer at Stripe too, which cancels its
   * subscriptions; `null` when the package held no row for the ref.
   */
  forgetCustomer(input: {
    readonly customerRef: string;
  }): Effect.Effect<{ readonly providerCustomerId: string | null } | null, BillingStorageError>;
}
