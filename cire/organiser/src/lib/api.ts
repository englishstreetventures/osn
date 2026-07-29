// All cire/api calls go through useAuth().authFetch so the cire session
// cookie rides along on every request. Components call useAuth() directly
// (they all render under the single AuthProvider root in OrganiserApp)
// rather than importing a fetch singleton — authFetch lives in the
// AuthProvider context.
import { CIRE_API_URL } from "./osn";

export const apiUrl = (path: string) => `${CIRE_API_URL}${path}`;

/**
 * `authFetch` rejects with `AuthExpiredError` (from `@shared/rp-auth`) when
 * cire/api answers 401 — the session cookie is gone or expired. The error may
 * arrive wrapped, so the string check catches a FiberFailure printout too.
 * Callers should redirect to sign-in when this returns true.
 */
export function isAuthExpired(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "_tag" in err) {
    if ((err as { _tag: unknown })._tag === "AuthExpiredError") return true;
  }
  return String(err).includes("AuthExpiredError");
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
