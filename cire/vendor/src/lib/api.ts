// All cire/api calls go through useAuth().authFetch so the cire session
// cookie rides along on every request. Components call useAuth() directly
// (they all render under the single AuthProvider root in VendorApp)
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
 * Bounce to the login page on an expired session, remembering where the vendor
 * was so the sign-in can send them back to it (a thread, an organisation)
 * rather than to the dashboard. Only the same-origin path+query+hash is carried
 * (as `returnTo`), never an absolute URL, and the sign-in panel checks it again
 * before following it. `/login` itself is never remembered: it would loop.
 */
export function redirectToLogin(): void {
  if (signingOut) {
    window.location.href = "/login";
    return;
  }
  const here = window.location.pathname + window.location.search + window.location.hash;
  const target =
    window.location.pathname === "/login"
      ? "/login"
      : `/login?returnTo=${encodeURIComponent(here)}`;
  window.location.href = target;
}

/** Set from the moment a sign-out starts: see {@link signOutToLogin}. */
let signingOut = false;

/**
 * Sign out, then the login page with nothing to resume, so the next person to
 * sign in on this device does not land on the last one's page. Signing out
 * clears the session before the request returns, which sets off the app's
 * own expired-session redirect; while a sign-out runs, that redirect carries
 * nothing either.
 */
export async function signOutToLogin(logout: () => Promise<void>): Promise<void> {
  signingOut = true;
  try {
    await logout();
  } finally {
    window.location.href = "/login";
  }
}

/**
 * Map a caught error to a user-friendly message.
 * Known server codes → specific copy; everything else → generic fallback.
 * This maps at the display boundary only — the store still throws raw errors.
 */
// The key is an arbitrary server-supplied marker, so the contract is an
// index signature and the `??` below is the real miss handler.
interface FriendlyMessages {
  readonly [marker: string]: string;
}

const FRIENDLY: FriendlyMessages = {
  not_org_member: "You don't have access to that organisation.",
  claim_invalid: "This invite link is no longer valid.",
} satisfies Record<string, string>;

export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // The table is closed; the message is not. Probing it with an arbitrary
  // string is the point, and the `??` covers the miss.
  return FRIENDLY[msg] ?? "Something went wrong. Please try again.";
}
