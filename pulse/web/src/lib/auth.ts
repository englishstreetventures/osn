import { createAuthFetch, isAuthExpired, type RpAuthConfig } from "@shared/rp-auth";

/**
 * Where Pulse's own API lives. Every credentialed call goes here, never to
 * the issuer — the browser holds a Pulse session cookie and nothing else.
 */
export const PULSE_API_URL: string = import.meta.env.VITE_API_URL ?? "http://localhost:3001";

/**
 * Pulse is an OIDC **relying party**, not an identity provider. A WebAuthn
 * ceremony only runs on an origin same-site with the RP ID, which lives on
 * `musubi.social`, so no Pulse origin can mint or use an OSN credential.
 * `/api/auth/oidc/start` on Pulse's own API sends the browser to the issuer
 * and takes the code back in exchange for a Pulse session cookie.
 *
 * That cookie is `HttpOnly` and host-scoped, so the API has to be same-site
 * with this origin (`api.<pulse-domain>`) or the browser will not send it.
 */
export const authConfig: RpAuthConfig = { apiBase: PULSE_API_URL };

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
export const publicFetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = (
  input,
  init,
) => fetch(input, { ...init, credentials: "include" });

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
