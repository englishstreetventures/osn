/**
 * Cire API domain metrics.
 *
 * Bounded counters/histograms for cire. Every attribute value is a string-literal
 * union so cardinality is enforced at compile time — no IP / publicId / familyId
 * ever reaches a metric attribute (those belong in spans + logs only). Raw OTel
 * instruments are never constructed directly; everything goes through the
 * `@shared/observability` typed factory.
 *
 * Export caveat (workerd): cire/api runs on Cloudflare Workers, which has no
 * long-lived process to flush a metric reader. Until a workerd metric reader is
 * attached, the factory resolves to a no-op meter and `.inc()` costs ~nothing.
 * Defining the instrument now pins the naming + cardinality contract.
 */

import { createCounter } from "@shared/observability/metrics";

/** Canonical metric name consts — grep-able, refactor-safe. */
export const CIRE_METRICS = {
  originGuardRejections: "cire.origin_guard.rejections",
} as const;

/**
 * Why an origin-guard rejection fired. Bounded union (C5):
 * - `missing`  — state-changing request with no `Origin` header.
 * - `mismatch` — `Origin` present but not in the configured allowlist.
 */
export type OriginGuardRejectionReason = "missing" | "mismatch";

type OriginGuardRejectionAttrs = { reason: OriginGuardRejectionReason };

const originGuardRejections = createCounter<OriginGuardRejectionAttrs>({
  name: CIRE_METRICS.originGuardRejections,
  description: "State-changing requests rejected by the Origin guard, by reason (CSRF defence)",
  unit: "{rejection}",
});

/** Record a single origin-guard rejection. The ONLY way cire emits this metric. */
export const metricOriginGuardRejection = (reason: OriginGuardRejectionReason): void =>
  originGuardRejections.inc({ reason });
