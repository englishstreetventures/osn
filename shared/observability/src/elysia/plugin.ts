import { context, type Context, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";
import { Elysia } from "elysia";

import { redact } from "../logger/redact";
import { httpServerActiveRequests, recordHttpRequest } from "../metrics/http";
import { extractTraceContext } from "../tracing/propagation";

/**
 * Elysia observability plugin.
 *
 * One call wires up:
 * - Request ID propagation (`x-request-id` in / out; generated if absent)
 * - W3C traceparent extraction (inbound)
 * - A server span per request with OTel HTTP semconv attributes
 * - RED metrics (request count + duration histogram)
 * - In-flight request gauge
 *
 * Handlers don't need to do anything to benefit — spans and metrics are
 * emitted automatically on request lifecycle hooks.
 */
export interface ObservabilityPluginOptions {
  /** Service name, used for the span attribute `service.name`. */
  readonly serviceName: string;
}

type RequestState = {
  start: bigint;
  span: ReturnType<ReturnType<typeof trace.getTracer>["startSpan"]>;
  /**
   * OTel Context with the request span set as active. Stored so that
   * handlers can opt in to parent-child trace linkage via
   * `getRequestContext(request)` when running child spans manually.
   * Elysia's hook model does not let us wrap the handler invocation
   * in `context.with(...)`, so this is the best we can do without
   * patching Elysia internals — see the plugin docstring for details.
   */
  ctx: Context;
  route: string;
  method: string;
  requestId: string;
};

const REQUEST_STATE = new WeakMap<Request, RequestState>();

/**
 * Get the OTel `Context` carrying the inbound HTTP request's server
 * span, so caller code can manually use it as the parent of a child
 * span:
 *
 *   const parent = getRequestContext(request);
 *   context.with(parent, () => someChildWork());
 *
 * Returns `undefined` if the request was not seen by the plugin.
 *
 * NOTE: This is an escape hatch. Most code should not need it — the
 * plugin's server span and metric emission are automatic, and Effect
 * service spans created via `Effect.withSpan` will be correctly linked
 * into distributed traces via outbound W3C `traceparent` propagation.
 */
export const getRequestContext = (request: Request): Context | undefined =>
  REQUEST_STATE.get(request)?.ctx;

const genRequestId = (): string => {
  // Cheap random ID — crypto.randomUUID() is fine and bun has it globally.
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
};

/**
 * Strict format for client-supplied `x-request-id` (S-H3).
 * Accepts 1–64 ASCII alphanumerics plus `_-.`. Rejects CRLF,
 * whitespace, control chars, ANSI escapes, and anything that could
 * inject into log lines or terminal output for operators tailing logs.
 */
const REQUEST_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;

const sanitizeInboundRequestId = (raw: string | null): string | null => {
  if (raw === null) return null;
  return REQUEST_ID_RE.test(raw) ? raw : null;
};

/**
 * Decide whether to honour an inbound W3C `traceparent` (S-H2).
 *
 * For public-facing HTTP, trusting upstream trace context is a privilege
 * escalation — external callers could force 100% sampling (financial
 * DoS on trace ingest), inject chosen trace IDs to muddle incident
 * response, or link their requests to internal traces in dashboards.
 *
 * Rule: only honour `traceparent` when the caller presents an
 * `Authorization: ARC ...` header (first-party S2S). All other
 * requests start a fresh root span. ARC-authenticated requests
 * carry an already-trusted identity, so propagating their trace
 * context is safe and gives us end-to-end distributed traces.
 */
const shouldHonourInboundTraceparent = (headers: Headers): boolean => {
  const auth = headers.get("authorization");
  return auth !== null && auth.startsWith("ARC ");
};

export const observabilityPlugin = (options: ObservabilityPluginOptions) => {
  const tracer = trace.getTracer("@shared/observability");

  return new Elysia({ name: "@shared/observability/plugin" })
    .onRequest(({ request, set }) => {
      const method = request.method.toUpperCase();
      const url = new URL(request.url);

      // S-H3: never echo a client-controlled id back untouched.
      const inboundRequestId = sanitizeInboundRequestId(request.headers.get("x-request-id"));
      const requestId = inboundRequestId ?? genRequestId();

      // Echo the (now-sanitized) request ID back to the client so they
      // can correlate. Guaranteed safe for logs and HTTP headers.
      set.headers = set.headers ?? {};
      set.headers["x-request-id"] = requestId;

      // Increment in-flight gauge.
      httpServerActiveRequests.inc({ "http.request.method": method });

      // S-H2: only extract inbound trace context from ARC-authenticated
      // callers. Anonymous/public requests start a fresh root span.
      const inboundCtx = shouldHonourInboundTraceparent(request.headers)
        ? extractTraceContext(request.headers)
        : undefined;
      const span = tracer.startSpan(
        `HTTP ${method}`,
        {
          kind: SpanKind.SERVER,
          attributes: {
            "http.request.method": method,
            // S-H4: `url.path` only (no query) — query strings frequently
            // carry OAuth codes, magic-link tokens, presigned sigs, etc.
            "url.path": url.pathname,
            "url.scheme": url.protocol.replace(":", ""),
            "server.address": url.hostname,
            "service.name": options.serviceName,
            "osn.request.id": requestId,
          },
        },
        inboundCtx,
      );

      // Build an OTel Context carrying the request span as active, and
      // stash it on the request state. We deliberately do NOT try to
      // `context.with(ctx, () => {})` here — that callback would
      // immediately tear the context back down, so it was a no-op in
      // the previous version of this plugin (see P-W1). Elysia's hook
      // lifecycle (onRequest → handler → onAfterResponse are separate
      // invocations, not a single enclosing scope) means there is no
      // way to make an OTel `context.with(...)` span the whole
      // request via hooks alone.
      //
      // The practical consequences:
      //   1. `trace.getActiveSpan()` inside a synchronous handler will
      //      NOT see the server span. Callers that want child spans
      //      should use `getRequestContext(request)` + `context.with`
      //      explicitly, or rely on Effect.withSpan — Effect manages
      //      its own fiber-local span tree.
      //   2. Distributed traces across services still work correctly
      //      because inbound `traceparent` is captured on this span
      //      AND the outbound `instrumentedFetch` wrapper injects
      //      `traceparent` into S2S calls.
      //   3. Same-process HTTP → service parent-child linkage is a
      //      known limitation tracked in TODO.md.
      const ctx = trace.setSpan(inboundCtx ?? context.active(), span);

      REQUEST_STATE.set(request, {
        start: process.hrtime.bigint(),
        span,
        ctx,
        // IMPORTANT (S-C1): default to the fixed sentinel `"unmatched"`,
        // NOT `url.pathname`. Any request that short-circuits before
        // onAfterHandle (404, body validation failure, etc.) MUST record
        // as `unmatched` — otherwise attacker-controlled paths become
        // metric labels and explode cardinality (financial DoS on
        // Grafana Cloud's active-series billing + secret leakage from
        // URL path segments into observability storage).
        route: "unmatched",
        method,
        requestId,
      });
    })
    .onAfterHandle(({ request, route }) => {
      const state = REQUEST_STATE.get(request);
      if (state && route) {
        state.route = route;
        state.span.setAttribute("http.route", route);
      }
    })
    .onError(({ request, error, code }) => {
      const state = REQUEST_STATE.get(request);
      if (!state) return;
      // S-M3: `span.recordException(error)` iterates the error's
      // enumerable own properties and writes them to a span event. Effect
      // tagged errors frequently embed `email`, `handle`, `cause` etc.
      // as own props, which would land in trace storage unredacted.
      // Instead, build a scrubbed shape and record that.
      const safeError =
        error instanceof Error
          ? (() => {
              const r = redact(error) as { name?: string; message?: string };
              return Object.assign(new Error(typeof r.message === "string" ? r.message : ""), {
                name: typeof r.name === "string" ? r.name : "Error",
              });
            })()
          : new Error(String(code));
      state.span.recordException(safeError);
      state.span.setStatus({
        code: SpanStatusCode.ERROR,
        // The `message` field of setStatus is preserved verbatim in
        // span storage — route it through redact() first.
        message:
          error instanceof Error
            ? (redact({ message: error.message }) as { message: string }).message
            : String(code),
      });
    })
    .onAfterResponse(({ request, set }) => {
      const state = REQUEST_STATE.get(request);
      if (!state) return;

      const durationNs = process.hrtime.bigint() - state.start;
      const durationSeconds = Number(durationNs) / 1e9;
      const status = typeof set.status === "number" ? set.status : 200;

      state.span.setAttribute("http.response.status_code", status);
      if (status >= 500) {
        state.span.setStatus({ code: SpanStatusCode.ERROR, message: `HTTP ${status}` });
      }
      state.span.end();

      recordHttpRequest({
        method: state.method,
        route: state.route,
        status,
        durationSeconds,
      });
      httpServerActiveRequests.dec({ "http.request.method": state.method });

      REQUEST_STATE.delete(request);
    });
};
