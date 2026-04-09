import { context, propagation, trace } from "@opentelemetry/api";

/**
 * W3C Trace Context propagation helpers.
 *
 * OTel's default propagator reads/writes `traceparent` (and optionally
 * `tracestate`) headers. These helpers are thin wrappers so callers don't
 * need to import `@opentelemetry/api` directly.
 */

/**
 * Inject the current active span's trace context into an outbound
 * `Headers` instance. Mutates the headers.
 */
export const injectTraceContext = (headers: Headers): void => {
  propagation.inject(context.active(), headers, {
    set: (carrier, key, value) => {
      (carrier as Headers).set(key, String(value));
    },
  });
};

/**
 * Extract trace context from an inbound `Headers` instance (or a plain
 * record-of-strings). Returns the extracted Context, suitable for
 * `context.with(ctx, fn)`.
 */
export const extractTraceContext = (headers: Headers | Record<string, string | undefined>) => {
  return propagation.extract(context.active(), headers, {
    get: (carrier, key) => {
      if (carrier instanceof Headers) return carrier.get(key) ?? undefined;
      return (carrier as Record<string, string | undefined>)[key] ?? undefined;
    },
    keys: (carrier) => {
      if (carrier instanceof Headers) {
        const keys: string[] = [];
        carrier.forEach((_v, k) => keys.push(k));
        return keys;
      }
      return Object.keys(carrier as Record<string, string | undefined>);
    },
  });
};

/** Return the current active span's trace ID, or undefined if no active span. */
export const currentTraceId = (): string | undefined => {
  const span = trace.getActiveSpan();
  const sc = span?.spanContext();
  return sc?.traceId;
};

/** Return the current active span's span ID, or undefined if no active span. */
export const currentSpanId = (): string | undefined => {
  const span = trace.getActiveSpan();
  const sc = span?.spanContext();
  return sc?.spanId;
};
