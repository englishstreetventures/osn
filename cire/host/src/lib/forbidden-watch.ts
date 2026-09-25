// Notice when the API refuses the organiser a wedding they were working in.
//
// The API checks the caller's role on every request, so a 403 from a
// wedding-scoped route is the first sign the tab gets that the organiser was
// removed from the wedding or narrowed to a role without dashboard access.
// Frontend code: no Effect.
import type { AuthFetch } from "@shared/rp-auth";

/** Organiser routes scoped to one wedding: `/api/organiser/weddings/<id>/…`.
 *  The list route itself (`/api/organiser/weddings`) is not one of them. */
const WEDDING_ROUTE = /\/api\/organiser\/weddings\/[^/?#]+\//;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** True when a response is the API refusing the caller a wedding. */
export function refusesWedding(input: RequestInfo | URL, res: Response): boolean {
  return res.status === 403 && WEDDING_ROUTE.test(urlOf(input));
}

/**
 * Wrap `authFetch` so every refusal on a wedding-scoped route calls
 * `onRefused` with the time the refused request was sent. The response is
 * handed back untouched: the caller still shows its own error, and the refusal
 * is only a prompt to ask the API what the organiser may see now.
 */
export function watchForbidden(
  authFetch: AuthFetch,
  onRefused: (sentAt: number) => void,
): AuthFetch {
  return async (input, init) => {
    const sentAt = Date.now();
    const res = await authFetch(input, init);
    if (refusesWedding(input, res)) onRefused(sentAt);
    return res;
  };
}
