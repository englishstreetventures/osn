import { Effect } from "effect";

import { type FallbackOutcome, isFallbackOutcome, type RealtimeProduct } from "../protocol";
import { metricClientFallback } from "./metrics";

/** The largest beacon body a product route reads. */
export const MAX_FALLBACK_BEACON_BYTES = 64;

/**
 * The outcome a beacon body names, or null. Surrounding whitespace is ignored;
 * anything else must be exactly one outcome, so an empty body, an unknown
 * word, JSON or a longer string is refused.
 */
export function readFallbackOutcome(body: string): FallbackOutcome | null {
  const trimmed = body.trim();
  return isFallbackOutcome(trimmed) ? trimmed : null;
}

/**
 * Count one browser subscription that fell back, by product and outcome, and
 * log it. It never fails. The warning is there because counters record into
 * a no-op meter on workerd until an exporter is attached
 * (`wiki/shared/observability/observability-setup.md`, "Runtime split"), so on
 * a deployed Worker the line in Workers Logs is the only record.
 */
export const recordClientFallback = (
  product: RealtimeProduct,
  outcome: FallbackOutcome,
): Effect.Effect<void> =>
  Effect.sync(() => metricClientFallback(product, outcome)).pipe(
    Effect.andThen(Effect.logWarning("realtime client fell back", { product, outcome })),
  );
