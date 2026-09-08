// All cire/api calls go through useAuth().authFetch so the cire session
// cookie rides along on every request. Components call useAuth() directly
// (they all render under the single AuthProvider root in OrganiserApp)
// rather than importing a fetch singleton — authFetch lives in the
// AuthProvider context.
import { CIRE_API_URL } from "./osn";

export const apiUrl = (path: string) => `${CIRE_API_URL}${path}`;

/**
 * The tag as an error NAME at the head of the printout — bare, or behind
 * Effect's `(FiberFailure)` prefix. Anchored, not a substring scan:
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

/**
 * `Promise.all` for calls whose rejections are not equally important.
 *
 * `Promise.all` adopts whichever rejection settles FIRST, and that is decided
 * by timing rather than by what the caller needs to hear about. Every caller
 * here loads several slices at once and handles exactly one failure specially:
 * an expired session, which must reach `redirectToLogin()` rather than a
 * "couldn't load" banner the organiser can do nothing about. If any other
 * slice rejects a tick earlier — because a generation-discarded load left it
 * unusable, say — `Promise.all` hands that reason to the catch, `isAuthExpired`
 * returns false, and the redirect is silently lost.
 *
 * This settles all of them and rethrows an expired session in preference to
 * anything else, so the reason is chosen by severity. With no auth failure
 * among them it behaves exactly as `Promise.all` does: the first rejection,
 * or the resolved values in order.
 */
export async function allAuthFirst<T extends readonly Promise<unknown>[]>(
  promises: readonly [...T],
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  const results = await Promise.allSettled(promises);
  // An expired session wins over any other reason; failing that, the first
  // rejection, which is what `Promise.all` would have thrown anyway.
  let chosen: { readonly reason: unknown } | undefined;
  for (const result of results) {
    if (result.status !== "rejected") continue;
    if (isAuthExpired(result.reason)) {
      chosen = result;
      break;
    }
    chosen ??= result;
  }
  if (chosen) throw chosen.reason;
  // Nothing rejected, so every promise is already settled and this resolves on
  // the next tick with the values in order. Deferring to `Promise.all` here
  // rather than collecting them by hand is what lets the return type be its
  // type: no assertion, and no chance of the two drifting apart.
  return Promise.all(promises);
}
