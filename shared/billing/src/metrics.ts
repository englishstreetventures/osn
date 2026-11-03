/**
 * `@shared/billing` metrics: the one place they are declared.
 *
 * Every attribute is a closed string-literal union. Provider strings (event
 * types, subscription statuses) go through {@link bucketEventType} and
 * {@link bucketStatus} first, so a value Stripe adds tomorrow lands in `other`
 * rather than minting a series. No customer, subscription or event id is ever
 * an attribute; those belong on spans and in logs.
 *
 * On Workers the OpenTelemetry meter has no reader, so these record nothing
 * there; every failure they count is also logged.
 */

import {
  createCounter,
  createHistogram,
  LATENCY_BUCKETS_SECONDS,
} from "@shared/observability/metrics";

import { isKnownStatus, type AccessReason, type KnownStatus } from "./policy";

export const BILLING_METRICS = {
  checkoutStarted: "osn.billing.checkout.started",
  portalOpened: "osn.billing.portal.opened",
  webhookReceived: "osn.billing.webhook.received",
  subscriptionTransitions: "osn.billing.subscription.transitions",
  accessChecked: "osn.billing.access.checked",
  accessApplied: "osn.billing.access.applied",
  providerRequestDuration: "osn.billing.provider.request.duration",
  reconcileSubscriptions: "osn.billing.reconcile.subscriptions",
} as const;

/** The Stripe event types the webhook acts on. Anything else is `other`. */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
] as const;
export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];
const HANDLED: ReadonlySet<string> = new Set(HANDLED_EVENT_TYPES);
export const isHandledEventType = (type: string): type is HandledEventType => HANDLED.has(type);

export type EventTypeAttr = HandledEventType | "other";
export const bucketEventType = (type: string): EventTypeAttr =>
  isHandledEventType(type) ? type : "other";

export type StatusAttr = KnownStatus | "none" | "other";
export const bucketStatus = (status: string | null): StatusAttr =>
  status === null ? "none" : isKnownStatus(status) ? status : "other";

/** Every Stripe call the package makes, runtime and sync. */
export type StripeOp =
  | "create_customer"
  | "list_prices"
  | "create_checkout_session"
  | "retrieve_checkout_session"
  | "expire_checkout_session"
  | "create_portal_session"
  | "retrieve_subscription"
  | "retrieve_invoice"
  | "retrieve_product"
  | "create_product"
  | "update_product"
  | "create_price"
  | "update_price"
  | "list_portal_configurations"
  | "create_portal_configuration"
  | "update_portal_configuration";

export type ProviderOutcome =
  | "ok"
  | "rejected"
  | "timeout"
  | "unreachable"
  | "unreadable"
  | "unexpected";

export type CheckoutOutcome =
  | "created"
  | "reused"
  | "already_subscribed"
  | "in_flight"
  | "currency_not_offered"
  | "plan_unavailable"
  | "error";
export type PortalOutcome = "opened" | "no_customer" | "error";
export type WebhookOutcome =
  | "processed"
  | "ignored"
  | "duplicate"
  | "refused_connect"
  | "invalid_signature"
  | "too_large"
  | "lease_held"
  | "error";
export type AccessSource = "webhook" | "sweep" | "reconcile" | "grant" | "reapply";
export type AccessAppliedOutcome = "applied" | "busy" | "hook_failed" | "error";
export type ReconcileOutcome = "refreshed" | "missing" | "error";

const checkoutStarted = createCounter<{ outcome: CheckoutOutcome }>({
  name: BILLING_METRICS.checkoutStarted,
  description: "Subscription checkout attempts by outcome",
  unit: "{attempt}",
});
const portalOpened = createCounter<{ outcome: PortalOutcome }>({
  name: BILLING_METRICS.portalOpened,
  description: "Billing portal session requests by outcome",
  unit: "{attempt}",
});
const webhookReceived = createCounter<{ type: EventTypeAttr; outcome: WebhookOutcome }>({
  name: BILLING_METRICS.webhookReceived,
  description: "Billing webhook deliveries by event type and outcome",
  unit: "{event}",
});
const subscriptionTransitions = createCounter<{ from: StatusAttr; to: StatusAttr }>({
  name: BILLING_METRICS.subscriptionTransitions,
  description: "Stored subscription status changes",
  unit: "{transition}",
});
const accessChecked = createCounter<{ reason: AccessReason; allowed: "true" | "false" }>({
  name: BILLING_METRICS.accessChecked,
  description: "Feature access checks by deciding reason",
  unit: "{check}",
});
const accessApplied = createCounter<{ source: AccessSource; outcome: AccessAppliedOutcome }>({
  name: BILLING_METRICS.accessApplied,
  description: "onAccess applications by caller and outcome",
  unit: "{application}",
});
const providerRequestDuration = createHistogram<{ op: StripeOp; outcome: ProviderOutcome }>({
  name: BILLING_METRICS.providerRequestDuration,
  description: "Billing provider call duration by operation and outcome",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});
const reconcileSubscriptions = createCounter<{ outcome: ReconcileOutcome }>({
  name: BILLING_METRICS.reconcileSubscriptions,
  description: "Subscriptions re-fetched by reconcile, by outcome",
  unit: "{subscription}",
});

export const metricCheckout = (outcome: CheckoutOutcome) => checkoutStarted.inc({ outcome });
export const metricPortal = (outcome: PortalOutcome) => portalOpened.inc({ outcome });
export const metricWebhook = (type: string, outcome: WebhookOutcome) =>
  webhookReceived.inc({ type: bucketEventType(type), outcome });
export const metricTransition = (from: string | null, to: string) =>
  subscriptionTransitions.inc({ from: bucketStatus(from), to: bucketStatus(to) });
export const metricAccessChecked = (reason: AccessReason, allowed: boolean) =>
  accessChecked.inc({ reason, allowed: allowed ? "true" : "false" });
export const metricAccessApplied = (source: AccessSource, outcome: AccessAppliedOutcome) =>
  accessApplied.inc({ source, outcome });
export const metricProviderRequest = (op: StripeOp, outcome: ProviderOutcome, seconds: number) =>
  providerRequestDuration.record(seconds, { op, outcome });
export const metricReconcile = (outcome: ReconcileOutcome) =>
  reconcileSubscriptions.inc({ outcome });
