/**
 * How Pulse web reaches pulse-api, from the browser and from the server that
 * renders a page.
 *
 * The browser talks to one origin only: this one. pulse-api is mounted under
 * `/api` on it (`routes/api/[...path].ts`), so the session cookie pulse-api
 * sets lands host-only on the web origin, and every page request the
 * rendering server receives carries it. Paths under `/api/auth/` reach
 * pulse-api unchanged; every other `/api/<rest>` reaches it as `/<rest>`.
 *
 * The rendering server calls pulse-api directly at `PULSE_API_INTERNAL_URL`,
 * with pulse-api's own paths, and passes on the page request's session
 * cookie and nothing else.
 */

import { getRequestEvent, isServer } from "solid-js/web";

export type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** The cookie pulse-api sets for a signed-in browser. */
export const SESSION_COOKIE = "pulse_web_session";

/** pulse-api's local default, the `PORTLESS=0` port. */
const LOCAL_API = "http://localhost:3001";

/** Where pulse-api is mounted on the web origin, for links written into HTML. */
export const API_MOUNT = "/api";

/**
 * pulse-api's own origin, as the server reaches it. Server-only: the browser
 * never learns it, and nothing it renders into a page may contain it.
 */
export function internalApiUrl(): string {
  return (process.env.PULSE_API_INTERNAL_URL || LOCAL_API).replace(/\/+$/, "");
}

/** Base for pulse-api's data routes (`/events`, `/me/…`), read per call. */
export function dataBase(): string {
  return isServer ? internalApiUrl() : `${window.location.origin}${API_MOUNT}`;
}

/**
 * Base `@shared/rp-auth` appends `/api/auth` to. The browser's auth routes are
 * the web origin's own `/api/auth/*`; the server's are pulse-api's.
 */
export function authBase(): string {
  return isServer ? internalApiUrl() : window.location.origin;
}

const urlOf = (input: RequestInfo | URL): string =>
  typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

const originOf = (url: string): string | null => {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
};

/** The session token out of a `Cookie:` header, or null. Token characters only. */
function sessionToken(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  for (const pair of cookieHeader.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0 || pair.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const value = pair.slice(eq + 1).trim();
    return /^[A-Za-z0-9._-]+$/.test(value) ? value : null;
  }
  return null;
}

export interface ServerCallContext {
  /** The `Cookie` header of the page request being rendered. */
  cookieHeader: string | null;
  /** pulse-api's origin; the only one the session cookie is ever sent to. */
  apiOrigin: string;
  fetch: Fetch;
}

/**
 * A call from the rendering server. It sends pulse-api the page request's
 * `pulse_web_session` and no other cookie, sends it to no other origin, and
 * never passes `credentials`, which workerd refuses.
 */
export function serverFetch(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  context: ServerCallContext,
): Promise<Response> {
  const { credentials: _credentials, headers: given, ...rest } = init ?? {};
  const headers = new Headers(given);
  headers.delete("cookie");
  const token = sessionToken(context.cookieHeader);
  if (token && originOf(urlOf(input)) === originOf(context.apiOrigin)) {
    headers.set("cookie", `${SESSION_COOKIE}=${token}`);
  }
  return context.fetch(input, { ...rest, headers });
}

/**
 * The one `fetch` every pulse-api call goes through. In the browser it sends
 * the session cookie with `credentials: "include"`; on the server it forwards
 * the page request's session through `serverFetch`. The global `fetch` is
 * resolved per call, so a test double installed after import is seen.
 */
export const transportFetch: Fetch = (input, init) => {
  if (isServer) {
    return serverFetch(input, init, {
      cookieHeader: getRequestEvent()?.request.headers.get("cookie") ?? null,
      apiOrigin: internalApiUrl(),
      fetch: (i, n) => fetch(i, n),
    });
  }
  return fetch(input, { ...init, credentials: "include" });
};
