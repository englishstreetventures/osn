import { context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

import { injectTraceContext } from "../tracing/propagation";

/**
 * Wraps `fetch` with OTel tracing + W3C traceparent propagation.
 *
 * Every outbound HTTP call from OSN services (ARC S2S, third-party APIs,
 * etc.) should go through this instead of `globalThis.fetch`. It:
 *
 * 1. Creates a client span (`HTTP <METHOD>`) with semconv attributes
 * 2. Injects `traceparent` into the outgoing headers so the receiving
 *    service's span becomes a child of ours
 * 3. Records status + error on the span
 *
 * For S2S calls that also need ARC auth, attach the `Authorization: ARC ...`
 * header on the `init` as normal — this wrapper leaves it alone.
 */
type FetchFn = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => Promise<Response>;

export const instrumentedFetch: FetchFn = async (input, init) => {
  const tracer = trace.getTracer("@shared/observability");
  const method = (init?.method ?? "GET").toUpperCase();

  let urlString: string;
  if (typeof input === "string") urlString = input;
  else if (input instanceof URL) urlString = input.toString();
  else urlString = input.url;

  // Parse URL for semconv attributes. Failure => emit a span without
  // the url.* attributes rather than crashing the request.
  let parsed: URL | undefined;
  try {
    parsed = new URL(urlString);
  } catch {
    parsed = undefined;
  }

  // S-H4: never record the query string on a span. URLs routinely
  // carry secrets in the query component (OAuth `code`, magic-link
  // `token`, presigned S3 signatures, OTP callbacks). Record only
  // `<scheme>://<host><port?><path>`. If parsing failed we have no
  // choice but to emit no `url.full` at all.
  const safeUrl = parsed ? `${parsed.protocol}//${parsed.host}${parsed.pathname}` : undefined;

  const span = tracer.startSpan(`HTTP ${method}`, {
    kind: SpanKind.CLIENT,
    attributes: {
      "http.request.method": method,
      ...(safeUrl && { "url.full": safeUrl }),
      ...(parsed && {
        "server.address": parsed.hostname,
        "server.port": parsed.port ? Number(parsed.port) : undefined,
        "url.scheme": parsed.protocol.replace(":", ""),
        "url.path": parsed.pathname,
      }),
    },
  });

  // Reuse the caller's Headers instance when possible — avoids an
  // extra allocation per outbound call (P-I3). Only fall back to
  // constructing a new Headers when the caller passed a plain
  // record/array or nothing at all.
  const headers = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers);

  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      injectTraceContext(headers);
      // Only spread when we had to allocate a new Headers — if we're
      // reusing the caller's instance, `init` already points at it.
      const response =
        init?.headers instanceof Headers
          ? await globalThis.fetch(input, init)
          : await globalThis.fetch(input, { ...init, headers });
      span.setAttribute("http.response.status_code", response.status);
      if (response.status >= 400) {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `HTTP ${response.status}`,
        });
      }
      return response;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      span.end();
    }
  });
};
