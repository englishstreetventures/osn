import { createAuthFetch, isAuthExpired, type RpAuthConfig } from "@shared/rp-auth";

import { authBase, transportFetch } from "./transport";

/**
 * Pulse is an OIDC **relying party**, not an identity provider. A WebAuthn
 * ceremony only runs on an origin same-site with the RP ID, which lives on
 * `musubi.social`, so no Pulse origin can mint or use an OSN credential.
 * `/api/auth/oidc/start` sends the browser to the issuer and takes the code
 * back in exchange for a Pulse session cookie.
 *
 * Those routes are on this web origin (pulse-api mounted under `/api`), so the
 * cookie is host-only here and every page request carries it to the server
 * that renders the page. `apiBase` is read per call: the browser's is this
 * origin, the rendering server's is pulse-api's own (`lib/transport.ts`).
 */
export const authConfig: RpAuthConfig = {
  get apiBase() {
    return authBase();
  },
  fetch: transportFetch,
};

/**
 * `fetch` for calls that need a signed-in caller: sends the session cookie
 * and turns a 401 into `AuthExpiredError`, which the UI reads as "bounce to
 * sign-in" rather than "show an error".
 */
export const authFetch = createAuthFetch(authConfig);

/**
 * `fetch` for reads a signed-out visitor is allowed to make. Same cookie —
 * the server widens what it returns when it recognises the caller — but a
 * 401 stays a 401, because these callers already treat "no data" as an
 * ordinary answer and must not be thrown out of the page for it.
 */
export const publicFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> =
  transportFetch;

/** True when `authFetch` rejected because the session cookie no longer names anyone. */
export const isExpired: (err: unknown) => boolean = isAuthExpired;

const EXPIRED_COPY = "Your sign-in has expired. Sign in again to continue.";

/**
 * Turns whatever `authFetch` threw into a line a mutation can hand back to
 * its caller. An expired session gets its own wording, because "something
 * went wrong" would send the user hunting for a fault that isn't theirs.
 */
export function expiredMessage(err: unknown): string {
  if (isExpired(err)) return EXPIRED_COPY;
  return err instanceof Error ? err.message : "Something went wrong. Try again.";
}
