// All cire/api calls go through useAuth().authFetch so the OSN access
// token is attached + silently refreshed. Components call useAuth()
// directly (they all render under the single AuthProvider root in
// OrganiserApp) rather than importing a fetch singleton — authFetch
// lives in the AuthProvider context.
import { CIRE_API_URL } from "./osn";

export const apiUrl = (path: string) => `${CIRE_API_URL}${path}`;

/**
 * `authFetch` rejects when the access token is expired and the silent
 * refresh cycle has failed (`AuthExpiredError` from @osn/client, surfaced
 * through Effect's runtime as a FiberFailure whose printout carries the
 * tag). Callers should redirect to sign-in when this returns true.
 */
export function isAuthExpired(err: unknown): boolean {
  if (typeof err === "object" && err !== null && "_tag" in err) {
    if ((err as { _tag: unknown })._tag === "AuthExpiredError") return true;
  }
  return String(err).includes("AuthExpiredError");
}

export function redirectToLogin(): void {
  window.location.href = "/login";
}

/**
 * Map a caught error to a user-friendly message.
 * Known server codes → specific copy; everything else → generic fallback.
 * This maps at the display boundary only — the store still throws raw errors.
 */
const FRIENDLY: Record<string, string> = {
  not_org_member: "You don't have access to that organisation.",
  claim_invalid: "This invite link is no longer valid.",
};

export function friendlyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return FRIENDLY[msg] ?? "Something went wrong. Please try again.";
}
