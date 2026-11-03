import { Data } from "effect";

/** A plan id no `definePlan` declared. */
export class UnknownPlan extends Data.TaggedError("UnknownPlan")<{ readonly planId: string }> {}

/** A feature id no plan declares. */
export class UnknownFeature extends Data.TaggedError("UnknownFeature")<{
  readonly featureId: string;
}> {}

/**
 * The plan cannot be sold: Stripe has no active price under its lookup key
 * (`missing`, not synced), or the price there names another plan (`mismatched`).
 */
export class PlanUnavailable extends Data.TaggedError("PlanUnavailable")<{
  readonly planId: string;
  readonly reason: "missing" | "mismatched";
}> {}

/** The plan's Stripe price has no amount in the requested currency. */
export class CurrencyNotOffered extends Data.TaggedError("CurrencyNotOffered")<{
  readonly planId: string;
  readonly currency: string;
}> {}

/** The customer already holds a live subscription in the plan's group. */
export class AlreadySubscribed extends Data.TaggedError("AlreadySubscribed")<{
  readonly group: string;
}> {}

/**
 * A checkout for this customer is under way: a session completed and its
 * webhook has not landed, or another request is creating one right now.
 */
export class CheckoutInFlight extends Data.TaggedError("CheckoutInFlight")<{}> {}

/** The customer has never been to checkout, so there is no portal to open. */
export class NoBillingCustomer extends Data.TaggedError("NoBillingCustomer")<{}> {}

/** Another process holds this customer's access lease, or kept writing under it. */
export class AccessBusy extends Data.TaggedError("AccessBusy")<{}> {}

/** The consumer's `onAccess` hook failed or ran past its timeout. */
export class AccessHookError extends Data.TaggedError("AccessHookError")<{
  readonly reason: "failed" | "timeout";
}> {}

/** A storage call failed. `message` is `String(cause)`, which carries no bound values. */
export class BillingStorageError extends Data.TaggedError("BillingStorageError")<{
  readonly operation: string;
  readonly message: string;
}> {}

/** A billing provider call failed. Carries the provider's code, never its message. */
export class BillingProviderError extends Data.TaggedError("BillingProviderError")<{
  readonly reason: string;
  readonly status?: number;
  readonly code?: string;
}> {}

/** A webhook body that cannot be shown to come from the provider. Answered 400. */
export class WebhookSignatureError extends Data.TaggedError("WebhookSignatureError")<{
  readonly reason: "malformed" | "no-match" | "too-old" | "unconfigured";
}> {}
