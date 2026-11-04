import {
  type Link,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  TraceFlags,
  trace,
} from "@opentelemetry/api";
import { Elysia } from "elysia";

import type { HttpMethod } from "../metrics/attrs";
import { httpServerActiveRequests, recordHttpRequest, toHttpMethod } from "../metrics/http";
import { extractTraceContext } from "../tracing/propagation";

/**
 * Elysia observability plugin.
 *
 * One call wires up:
 * - Request ID propagation (`x-request-id` in / out; generated if absent)
 * - Inbound W3C trace context kept as a span link, never the parent
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
  route: string;
  method: HttpMethod;
  requestId: string;
};

const REQUEST_STATE = new WeakMap<Request, RequestState>();

const genRequestId = (): string => {
  // Cheap random ID — crypto.randomUUID() is fine and bun has it globally.
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
};

/**
 * Strict format for client-supplied `x-request-id`.
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
 * The span link for a request's inbound W3C `traceparent`, when it is well
 * formed.
 *
 * The caller chooses every field of a `traceparent`, and the plugin runs
 * before any route checks credentials, so no header it sees proves who sent
 * the request. The inbound context is therefore never the server span's
 * parent, which would hand the caller the trace id and, through a
 * parent-based sampler, the sampling decision. A link keeps it for
 * correlation and decides neither, as long as no sampler reads links. It is
 * the caller's unverified claim: the link holds only its trace id, span id
 * and sampled bit, and `tracestate` and `baggage` are never parsed.
 */
const inboundTraceLinks = (headers: Headers): Link[] | undefined => {
  const traceparent = headers.get("traceparent");
  if (traceparent === null) return undefined;
  // Extracted onto the root context, so the only span context the result can
  // hold is one the propagator parsed from this header; the W3C propagator
  // parses only a well-formed `traceparent` with non-zero ids.
  const inbound = trace.getSpanContext(extractTraceContext({ traceparent }, ROOT_CONTEXT));
  if (inbound === undefined) return undefined;
  return [
    {
      context: {
        traceId: inbound.traceId,
        spanId: inbound.spanId,
        traceFlags: inbound.traceFlags & TraceFlags.SAMPLED,
        isRemote: true,
      },
    },
  ];
};

export const observabilityPlugin = (options: ObservabilityPluginOptions) => {
  const tracer = trace.getTracer("@shared/observability");

  // `.as("global")` at the end lifts every hook to the app that mounts the
  // plugin. Elysia keeps a plugin's hooks local by default, and this
  // instance has no routes of its own, so without it only `onRequest` runs.
  return new Elysia({ name: "@shared/observability/plugin" })
    .onRequest(({ request, set }) => {
      // A closed set, so a made-up method cannot mint metric series.
      const method = toHttpMethod(request.method);
      const url = new URL(request.url);

      // Never echo a client-controlled id back untouched.
      const inboundRequestId = sanitizeInboundRequestId(request.headers.get("x-request-id"));
      const requestId = inboundRequestId ?? genRequestId();

      // Echo the (now-sanitized) request ID back to the client so they
      // can correlate. Guaranteed safe for logs and HTTP headers.
      set.headers = set.headers ?? {};
      set.headers["x-request-id"] = requestId;

      // Increment in-flight gauge.
      httpServerActiveRequests.inc({ "http.request.method": method });

      // Every server span is a root, so the registered sampler makes its own
      // decision; neither an inbound `traceparent` nor a span active in the
      // calling context is its parent. Elysia runs onRequest, the handler and
      // onAfterResponse as separate calls, so this span is never active
      // inside a handler (wiki/shared/observability/tracing.md §Elysia hook
      // limitation).
      const span = tracer.startSpan(`HTTP ${method}`, {
        kind: SpanKind.SERVER,
        root: true,
        links: inboundTraceLinks(request.headers),
        attributes: {
          "http.request.method": method,
          // No `url.path` or query: paths hold handles and profile ids,
          // and queries carry OAuth codes and magic-link tokens. The span
          // names the matched route template (`http.route`) instead.
          "url.scheme": url.protocol.replace(":", ""),
          "server.address": url.hostname,
          "service.name": options.serviceName,
          "osn.request.id": requestId,
        },
      });

      REQUEST_STATE.set(request, {
        start: process.hrtime.bigint(),
        span,
        // IMPORTANT: default to the fixed sentinel `"unmatched"`,
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
      // Span storage gets the error's name and Elysia's error code, never
      // the error's message or stack: a message is free text that
      // `redact()`, which scrubs object keys, cannot clean, and Elysia's
      // validation errors put the rejected input in theirs.
      state.span.recordException({
        name: error instanceof Error ? error.name : "Error",
        message: String(code),
      });
      state.span.setStatus({ code: SpanStatusCode.ERROR, message: String(code) });
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
    })
    .as("global");
};
