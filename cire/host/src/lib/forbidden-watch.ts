// Notice when the API refuses the organiser a wedding they were working in.
//
// The API checks the caller's role on every request, so a 403 from a
// wedding-scoped route is the first sign the tab gets that the organiser was
// removed from the wedding or narrowed to a role without dashboard access. A
// 404 carrying the gates' own `wedding_not_found` is the sign that the wedding
// itself is gone — another owner deleted it. Any other 404 is a row inside the
// wedding and says nothing about access.
// Frontend code: no Effect.
import type { AuthFetch } from "@shared/rp-auth";

/** Organiser routes scoped to one wedding: `/api/organiser/weddings/<id>/…`.
 *  The list route itself (`/api/organiser/weddings`) is not one of them. */
const WEDDING_ROUTE = /\/api\/organiser\/weddings\/[^/?#]+\//;

/** The body every wedding gate answers an unknown or deleted wedding with. */
const WEDDING_GONE = "wedding_not_found";

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The `error` a JSON body names, read from a copy so the caller's body is untouched. */
async function errorOf(res: Response): Promise<string | null> {
  try {
    const body: unknown = await res.clone().json();
    return body && typeof body === "object" && "error" in body && typeof body.error === "string"
      ? body.error
      : null;
  } catch {
    return null;
  }
}

/** True when a response is the API refusing the caller a wedding, or saying it is gone. */
export async function refusesWedding(input: RequestInfo | URL, res: Response): Promise<boolean> {
  if (!WEDDING_ROUTE.test(urlOf(input))) return false;
  if (res.status === 403) return true;
  return res.status === 404 && (await errorOf(res)) === WEDDING_GONE;
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
    if (await refusesWedding(input, res)) onRefused(sentAt);
    return res;
  };
}
