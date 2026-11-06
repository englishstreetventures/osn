/**
 * The secret an emailed link carries in its fragment
 * (`/verify/<request id>#<secret>`), taken off the address bar before the app
 * renders or makes any request.
 *
 * `captureEmailLinkSecret` runs once, from `index.tsx`, before the app renders
 * and after the canonical-host check has decided not to redirect (that
 * redirect carries the fragment to the real origin, so it must still be
 * there). It removes the fragment with `history.replaceState`, so the secret
 * is not left in the address bar, in history, or for anything on the route
 * that reads `location` later.
 *
 * The secret is a one-use credential, held in this module's memory only —
 * never in `sessionStorage`, `localStorage` or a cookie. A reload therefore
 * loses it; the link in the email still works.
 */

const PREFIX = "/verify/";

let captured: { readonly requestId: string; readonly secret: string } | null = null;

/** The request id in `/verify/<request id>`, or null on any other path. */
export function emailLinkRequestId(pathname: string): string | null {
  if (!pathname.startsWith(PREFIX)) return null;
  const id = pathname.slice(PREFIX.length).replace(/\/$/, "");
  return id && !id.includes("/") ? id : null;
}

/** Reads `/verify/<id>#<secret>` once, keeps the secret, and clears the fragment. */
export function captureEmailLinkSecret(): void {
  if (typeof window === "undefined") return;
  const requestId = emailLinkRequestId(window.location.pathname);
  const secret = window.location.hash.slice(1);
  if (!requestId || !secret) return;
  window.history.replaceState(
    window.history.state,
    "",
    window.location.pathname + window.location.search,
  );
  captured = { requestId, secret };
}

/** The secret captured for `requestId`, or null when this page load never held one. */
export function emailLinkSecret(requestId: string): string | null {
  return captured?.requestId === requestId ? captured.secret : null;
}
