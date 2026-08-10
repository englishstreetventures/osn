/**
 * CSRF origin guard for Pulse's cookie-authenticated surface — Copenhagen
 * Book M1.
 *
 * Until the web session landed, Pulse held no ambient browser credential: every
 * authenticated call carried a bearer access JWT (iOS) or an ARC token (S2S),
 * neither of which a cross-site page can attach. `pulse_web_session` changes
 * that, so state-changing requests that carry it need server-side `Origin`
 * validation on top of the cookie's own `SameSite=Lax`.
 *
 * **The guard fires only when the request carries the session cookie.** That is
 * the whole point of the check: CSRF is the theft of ambient authority, and a
 * request with no cookie has none to steal. Guarding every state-changing
 * request instead — which is what cire and osn-api do, because every one of
 * their write callers is a browser — would 403 the iOS app, which sends no
 * `Origin` header at all, and the unauthenticated `POST /events/:id/share` and
 * `/exposure` pings along with it.
 *
 * A cross-site attacker cannot escape the check by adding a header: a request
 * that carries `Authorization` is no longer a simple request, so the browser
 * preflights it and the CORS allowlist refuses. Cookie present ⇒ checked;
 * cookie absent ⇒ nothing to protect.
 *
 * Mounted as a root-level `onBeforeHandle` in `createApp`, before the route
 * factories, so it gates the whole app uniformly.
 */

import { Elysia } from "elysia";

import { metricOriginGuardRejection } from "../metrics";
import { hasWebSessionCookie } from "./cookie";

/** Methods that mutate state and therefore require Origin validation. */
const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Elysia plugin that 403s cookie-carrying state-changing requests whose
 * `Origin` is missing or not in `allowedOrigins`. An empty allowlist disables
 * the guard (local dev, where `createApp` is called without `corsOrigins`).
 */
export function originGuard(allowedOrigins: readonly string[]) {
  const allow = new Set(allowedOrigins);
  return new Elysia().onBeforeHandle({ as: "global" }, ({ request, set }) => {
    if (!STATE_CHANGING.has(request.method)) return;
    if (allow.size === 0) return;
    if (!hasWebSessionCookie(request.headers.get("cookie"))) return;

    const origin = request.headers.get("origin");
    if (!origin) {
      metricOriginGuardRejection("missing");
      set.status = 403;
      return { error: "forbidden", message: "Missing Origin header" };
    }
    if (!allow.has(origin)) {
      metricOriginGuardRejection("mismatch");
      set.status = 403;
      return { error: "forbidden", message: "Origin not allowed" };
    }
  });
}
