/**
 * Per-signal OTLP/HTTP URL construction.
 *
 * Its own module, deliberately: `./layer.ts` (the Bun/Node `NodeSdk` layer)
 * cannot be imported on workerd — its import graph pulls
 * `@effect/opentelemetry/NodeSdk` and the `@opentelemetry/sdk-*` packages, none
 * of which run there. `./otlp.ts` (the workerd-safe exporter) needs the same URL
 * rule, so the rule lives here where both can import it and only one of them
 * drags in Node. `./layer.ts` re-exports it so its existing import path keeps
 * working.
 */

/**
 * Build the per-signal OTLP HTTP endpoint URL from the base endpoint.
 *
 * `OTEL_EXPORTER_OTLP_ENDPOINT` is the *base* (e.g.
 * `https://otlp.grafana.net/otlp`); the OTLP/HTTP spec routes traces to
 * `<base>/v1/traces` and metrics to `<base>/v1/metrics`. We build the full
 * URL ourselves (and strip a trailing slash so we never emit `//v1/...`)
 * rather than leaning on the exporter's own env fallback — that fallback
 * silently defaults to `http://localhost:4318` when nothing is set, which is
 * exactly the "blind, perpetually-failing export" we want to avoid. Returns
 * `undefined` when no endpoint is configured so the caller can stay a no-op.
 */
export const otlpExporterUrl = (
  endpoint: string | undefined,
  signal: "traces" | "metrics",
): string | undefined => (endpoint ? `${endpoint.replace(/\/+$/, "")}/v1/${signal}` : undefined);
