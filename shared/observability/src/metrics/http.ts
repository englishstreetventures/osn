/**
 * Shared HTTP RED (Rate / Errors / Duration) metrics.
 *
 * These are emitted automatically by the Elysia plugin — handlers must
 * never call these directly. Their attributes are deliberately minimal
 * and use OTel HTTP semantic conventions so dashboards portable across
 * services work out of the box.
 *
 * Spec: https://opentelemetry.io/docs/specs/semconv/http/http-metrics/
 */

import {
  createCounter,
  createHistogram,
  createUpDownCounter,
  LATENCY_BUCKETS_SECONDS,
} from "./factory";

export type HttpAttrs = {
  /** HTTP method, uppercase. e.g. "GET", "POST". */
  "http.request.method": string;
  /** Elysia path template, NOT the actual URL. e.g. "/events/:id". */
  "http.route": string;
  /** Response status code as a string. e.g. "200", "404". */
  "http.response.status_code": string;
};

export type HttpInFlightAttrs = {
  "http.request.method": string;
};

export const httpServerRequests = createCounter<HttpAttrs>({
  name: "http.server.requests",
  description: "Total inbound HTTP requests",
  unit: "{request}",
});

export const httpServerRequestDuration = createHistogram<HttpAttrs>({
  name: "http.server.request.duration",
  description: "Inbound HTTP request duration",
  unit: "s",
  boundaries: LATENCY_BUCKETS_SECONDS,
});

export const httpServerActiveRequests = createUpDownCounter<HttpInFlightAttrs>({
  name: "http.server.active_requests",
  description: "HTTP requests currently in-flight",
  unit: "{request}",
});

/**
 * Record a completed HTTP request.
 *
 * The Elysia plugin is the ONLY allowed caller of this function.
 * Route handlers must not invoke it.
 */
export const recordHttpRequest = (params: {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
}): void => {
  const attrs: HttpAttrs = {
    "http.request.method": params.method.toUpperCase(),
    "http.route": params.route,
    "http.response.status_code": String(params.status),
  };
  httpServerRequests.inc(attrs);
  httpServerRequestDuration.record(params.durationSeconds, attrs);
};
