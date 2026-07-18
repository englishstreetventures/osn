import { Elysia } from "elysia";

/**
 * Phase-2 landing spot for the payment provider's purchase webhook. This
 * skeleton is PROVIDER-NEUTRAL so the provider is an adapter-level choice. In
 * Phase 1 it is INERT: it verifies nothing and grants nothing, returning 501.
 * createApp mounts it ONLY when the webhook flag is set, so no unverified
 * endpoint is ever exposed by default.
 *
 * Phase 2 will: verify the provider signature, map the purchased product →
 * entitlement key, and call entitlementService.grant({ source: "purchase",
 * providerRef: <provider order id> }) — idempotent on the provider order id.
 */
export function createPaymentWebhookSkeleton() {
  return new Elysia().post("/api/payments/webhook", ({ set }) => {
    set.status = 501;
    return { error: "not_implemented" };
  });
}
