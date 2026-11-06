/**
 * pulse-api, mounted under `/api` on the Pulse web origin.
 *
 * The browser sends every pulse-api call to its own origin, so the session
 * cookie pulse-api sets is host-only on the web origin and every page request
 * the rendering server sees carries it. This forwards those calls on:
 * `/api/auth/*` unchanged (pulse-api mounts its auth routes there), every
 * other `/api/<rest>` as `/<rest>`.
 *
 * What it guarantees:
 * - The upstream URL is pulse-api's configured origin plus a path built by
 *   string concatenation, and the request is refused before any call when the
 *   path could name another host or climb out of the mount.
 * - pulse-api's service and operator paths (`/internal/*`, `/health`,
 *   `/ready`, `/openapi*`) are not reachable through it.
 * - The browser's `Origin` and `Cookie` reach pulse-api as sent, so its CSRF
 *   origin guard judges the browser's request; `Authorization` and hop-by-hop
 *   headers never do.
 * - Every `Set-Cookie` pulse-api sends comes back, and redirects come back
 *   rather than being followed.
 * - An unreachable pulse-api is a `502` with a fixed body; no error text.
 */

import type { Fetch } from "./transport";

/** Paths under the mount that pulse-api serves as they are. */
const UNCHANGED_PREFIX = "/api/auth/";

/** Request headers that describe this hop, or that only pulse-api's other callers send. */
const DROPPED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "host",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Response headers that describe the upstream hop or a body the runtime has already decoded. */
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "keep-alive",
  "transfer-encoding",
]);

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/** pulse-api paths the web origin never exposes, compared lower-cased. */
const REFUSED_UPSTREAM = [/^\/internal(\/|$)/, /^\/health(\/|$)/, /^\/ready(\/|$)/, /^\/openapi/];

/** Encoded `/` or `\`: a separator pulse-api would see that this check did not. */
const ENCODED_SEPARATOR = /%2f|%5c/i;
/** An encoded `.`, which only a double-encoded dot-segment leaves after one decode. */
const ENCODED_DOT = /%2e/i;
const DOT_SEGMENT = /(^|\/)\.\.?(\/|$)/;

/**
 * pulse-api's path for a web-origin pathname, or null when the request must
 * not leave this origin.
 */
export function upstreamPath(pathname: string): string | null {
  if (!pathname.startsWith("/api/")) return null;
  const path = pathname.startsWith(UNCHANGED_PREFIX) ? pathname : pathname.slice("/api".length);
  if (path === "/") return null;

  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return null;
  }
  for (const form of [path, decoded]) {
    if (form.startsWith("//") || form.includes("\\") || form.includes("://")) return null;
    if (ENCODED_SEPARATOR.test(form) || DOT_SEGMENT.test(form)) return null;
  }
  if (ENCODED_DOT.test(decoded)) return null;

  const lower = decoded.toLowerCase();
  if (REFUSED_UPSTREAM.some((refused) => refused.test(lower))) return null;
  return path;
}

const notFound = (): Response =>
  new Response(JSON.stringify({ error: "not_found" }), {
    status: 404,
    headers: { "content-type": "application/json" },
  });

const unavailable = (): Response =>
  new Response(JSON.stringify({ error: "upstream_unavailable" }), {
    status: 502,
    headers: { "content-type": "application/json" },
  });

function forwardedHeaders(incoming: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of incoming) {
    if (DROPPED_REQUEST_HEADERS.has(name) || name.startsWith("proxy-")) continue;
    headers.append(name, value);
  }
  return headers;
}

function returnedHeaders(upstream: Headers): Headers {
  const headers = new Headers();
  for (const [name, value] of upstream) {
    if (DROPPED_RESPONSE_HEADERS.has(name)) continue;
    headers.append(name, value);
  }
  return headers;
}

/**
 * Forward `request` to pulse-api at `apiOrigin`. `fetchImpl` is the transport
 * for the call; it defaults to the global `fetch`, resolved per call.
 */
export async function proxyToPulseApi(
  request: Request,
  apiOrigin: string,
  fetchImpl: Fetch = (input, init) => fetch(input, init),
): Promise<Response> {
  const url = new URL(request.url);
  const path = upstreamPath(url.pathname);
  if (path === null) return notFound();

  const origin = apiOrigin.replace(/\/+$/, "");
  const target = `${origin}${path}${url.search}`;
  if (new URL(target).origin !== new URL(origin).origin) return notFound();

  const method = request.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD" && request.body !== null;
  const init: RequestInit & { duplex?: "half" } = {
    method,
    headers: forwardedHeaders(request.headers),
    redirect: "manual",
  };
  if (hasBody) {
    init.body = request.body;
    // A stream body needs it under Node's fetch; Bun and workerd accept it.
    init.duplex = "half";
  }

  let upstream: Response;
  try {
    upstream = await fetchImpl(target, init);
  } catch {
    return unavailable();
  }
  // A null-body status cannot be constructed with a body, even an empty one.
  const body = NULL_BODY_STATUSES.has(upstream.status) ? null : upstream.body;
  return new Response(body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: returnedHeaders(upstream.headers),
  });
}
