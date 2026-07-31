// All cire/api calls go through useAuth().authFetch so the cire session
// cookie rides along on every request. Components call useAuth() directly
// (they all render under the single AuthProvider root in OrganiserApp)
// rather than importing a fetch singleton — authFetch lives in the
// AuthProvider context.
import { CIRE_API_URL } from "./osn";

export const apiUrl = (path: string) => `${CIRE_API_URL}${path}`;

/**
 * The tag as an error NAME at the head of the printout — bare, or behind
 * Effect's `(FiberFailure)` prefix. Anchored, not a substring scan (S-L2):
 * errors reaching this predicate include `EnquiryApiError`, whose message is
 * the server's `error` code verbatim, so an unanchored match would let a
 * server-supplied string decide to sign the organiser out.
 */
const FIBER_FAILURE_PRINTOUT = /^(?:\(FiberFailure\)\s*)?AuthExpiredError\b/;

/**
 * `authFetch` rejects with `AuthExpiredError` (from `@shared/rp-auth`) when
 * cire/api answers 401 — the session cookie is gone or expired. The error may
 * arrive wrapped, so the printout check catches a FiberFailure form too.
 * Callers should redirect to sign-in when this returns true.
 */
export function isAuthExpired(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "_tag" in err) {
    if ((err as { _tag: unknown })._tag === "AuthExpiredError") return true;
  }
  // `String(x)` throws on a null-prototype object (no `toString` to reach).
  // This runs inside `catch` blocks, so a throw here would swap a recoverable
  // expiry for an unhandled rejection.
  try {
    return FIBER_FAILURE_PRINTOUT.test(String(err));
  } catch {
    return false;
  }
}

/**
 * Bounce to the login page on an expired session, remembering where the user
 * was so the post-login resume can send them back instead of always dumping
 * them on the dashboard. Only the same-origin path+query+hash is carried (as a
 * `returnTo` param) — never an absolute URL — so this can never become an open
 * redirect. `/login` itself is never remembered (it would just loop).
 */
export function redirectToLogin(): void {
  const here = window.location.pathname + window.location.search + window.location.hash;
  const target =
    window.location.pathname === "/login"
      ? "/login"
      : `/login?returnTo=${encodeURIComponent(here)}`;
  window.location.href = target;
}
