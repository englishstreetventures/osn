import { Effect, Schema } from "effect";

import { BillingProviderError } from "../errors";
import { metricProviderRequest, type ProviderOutcome, type StripeOp } from "../metrics";
import type { StripeError } from "./http";

const OUTCOMES: ReadonlySet<string> = new Set(["rejected", "timeout", "unreachable", "unreadable"]);
const outcomeOf = (reason: string): ProviderOutcome =>
  OUTCOMES.has(reason) ? (reason as ProviderOutcome) : "unexpected";

const toProviderError = (error: StripeError) =>
  new BillingProviderError({ reason: error.reason, status: error.status, code: error.code });

/**
 * One Stripe call, observed: a `billing.stripe.<op>` span, the duration metric
 * by outcome, and the error narrowed to the port's {@link BillingProviderError}.
 */
export const stripeCall = <A>(
  op: StripeOp,
  effect: Effect.Effect<A, StripeError | BillingProviderError>,
): Effect.Effect<A, BillingProviderError> =>
  Effect.suspend(() => {
    const started = performance.now();
    const record = (outcome: ProviderOutcome) =>
      Effect.sync(() => metricProviderRequest(op, outcome, (performance.now() - started) / 1000));
    return effect.pipe(
      Effect.mapError((error) => (error._tag === "StripeError" ? toProviderError(error) : error)),
      Effect.tap(() => record("ok")),
      Effect.tapError((error) => record(outcomeOf(error.reason))),
      Effect.withSpan(`billing.stripe.${op}`),
    );
  });

/** Decode a Stripe payload; a shape we cannot read is a provider failure, not a defect. */
export const decodeStripe =
  <S extends Schema.Top>(schema: S) =>
  (payload: unknown): Effect.Effect<S["Type"], BillingProviderError> =>
    Schema.decodeUnknownEffect(schema)(payload).pipe(
      Effect.mapError(() => new BillingProviderError({ reason: "unexpected_payload" })),
    ) as Effect.Effect<S["Type"], BillingProviderError>;
