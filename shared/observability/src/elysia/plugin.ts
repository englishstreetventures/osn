import { Elysia } from "elysia";

import type { HttpMethod } from "../metrics/attrs";
import { httpServerActiveRequests, recordHttpRequest, toHttpMethod } from "../metrics/http";

/**
 * Elysia observability plugin.
 *
 * One call wires up:
 * - Request ID propagation (`x-request-id` in / out; generated if absent)
 * - RED metrics (request count + duration histogram)
 * - In-flight request gauge
 *
 * It starts no span. On Cloudflare Workers the runtime records a handler span
 * for every invocation (`observability.traces` in the Worker's config); on Bun
 * nothing traces a request, only the Effect spans the handler runs.
 *
 * Handlers don't need to do anything to benefit — metrics are recorded
 * automatically on request lifecycle hooks.
 */
type RequestState = {
  start: bigint;
  route: string;
  method: HttpMethod;
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

export const observabilityPlugin = () => {
  // `.as("global")` at the end lifts every hook to the app that mounts the
  // plugin. Elysia keeps a plugin's hooks local by default, and this
  // instance has no routes of its own, so without it only `onRequest` runs.
  return new Elysia({ name: "@shared/observability/plugin" })
    .onRequest(({ request, set }) => {
      // A closed set, so a made-up method cannot mint metric series.
      const method = toHttpMethod(request.method);

      // Never echo a client-controlled id back untouched.
      const inboundRequestId = sanitizeInboundRequestId(request.headers.get("x-request-id"));
      const requestId = inboundRequestId ?? genRequestId();

      // Echo the (now-sanitized) request ID back to the client so they
      // can correlate. Guaranteed safe for logs and HTTP headers.
      set.headers = set.headers ?? {};
      set.headers["x-request-id"] = requestId;

      // Increment in-flight gauge.
      httpServerActiveRequests.inc({ "http.request.method": method });

      REQUEST_STATE.set(request, {
        start: process.hrtime.bigint(),
        // IMPORTANT: default to the fixed sentinel `"unmatched"`,
        // NOT `url.pathname`. Any request that short-circuits before
        // onAfterHandle (404, body validation failure, etc.) MUST record
        // as `unmatched` — otherwise attacker-controlled paths become
        // metric labels and explode cardinality (financial DoS on
        // Grafana Cloud's active-series billing + secret leakage from
        // URL path segments into observability storage).
        route: "unmatched",
        method,
      });
    })
    .onAfterHandle(({ request, route }) => {
      const state = REQUEST_STATE.get(request);
      if (state && route) state.route = route;
    })
    .onAfterResponse(({ request, set }) => {
      const state = REQUEST_STATE.get(request);
      if (!state) return;

      const durationNs = process.hrtime.bigint() - state.start;
      const durationSeconds = Number(durationNs) / 1e9;
      const status = typeof set.status === "number" ? set.status : 200;

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
