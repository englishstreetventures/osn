/**
 * Realtime metrics — every counter this package emits is declared here once.
 *
 * Attribute values are closed unions: the serving product, the signal kind and
 * an outcome. A topic, entity id or subject id never reaches an attribute;
 * those belong in logs and spans.
 */
import { createCounter } from "@shared/observability/metrics";

import type { RealtimeProduct, SignalKind } from "../protocol";

export const REALTIME_METRICS = {
  subscribeAttempts: "realtime.subscribe.attempts",
  signalPublished: "realtime.signal.published",
  hubCapacityRefused: "realtime.hub.capacity_refused",
} as const;

/**
 * How one subscribe request ended. Every outcome but `accepted` answers with a
 * plain HTTP status and never upgrades.
 */
export type SubscribeOutcome =
  | "accepted"
  | "not_upgrade"
  | "bad_origin"
  | "bad_topic"
  | "unauthenticated"
  | "rate_limited"
  | "denied"
  | "unavailable";

/** `disabled`: the product has no hub bound, so nothing was sent. */
export type PublishResult = "ok" | "error" | "disabled";

const subscribeAttempts = createCounter<{ product: RealtimeProduct; outcome: SubscribeOutcome }>({
  name: REALTIME_METRICS.subscribeAttempts,
  description: "WebSocket subscribe requests, by serving product and outcome",
  unit: "{request}",
});

const signalPublished = createCounter<{
  product: RealtimeProduct;
  kind: SignalKind;
  result: PublishResult;
}>({
  name: REALTIME_METRICS.signalPublished,
  description: "Signals handed to a hub after a write, by product, kind and result",
  unit: "{signal}",
});

const hubCapacityRefused = createCounter<{ product: RealtimeProduct }>({
  name: REALTIME_METRICS.hubCapacityRefused,
  description: "Sockets a hub closed because its topic was at the socket cap",
  unit: "{socket}",
});

export const metricSubscribe = (product: RealtimeProduct, outcome: SubscribeOutcome): void =>
  subscribeAttempts.inc({ product, outcome });

export const metricSignalPublished = (
  product: RealtimeProduct,
  kind: SignalKind,
  result: PublishResult,
): void => signalPublished.inc({ product, kind, result });

export const metricHubCapacityRefused = (product: RealtimeProduct): void =>
  hubCapacityRefused.inc({ product });
