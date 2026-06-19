import type { InviteCustomisation } from "../components/InviteHeader";

/** cire-api origin. Build/runtime env with a local-dev default. */
export const API_URL = import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787";

/** Discriminated result of a server-side invite fetch for a slug. */
export type InviteFetch =
  | { kind: "ok"; invite: InviteCustomisation }
  | { kind: "not-found" }
  | { kind: "error" };

/**
 * Fetch a wedding's invite customisation server-side (per request) from the
 * public invite endpoint. The `[slug]` route uses the result to render the hero
 * with the real image + copy in the SSR'd HTML, and to return a real 404 when
 * the slug doesn't map to a wedding.
 *
 *  - 200            → `{ kind: "ok", invite }`
 *  - 404            → `{ kind: "not-found" }` (unknown slug → the route 404s)
 *  - non-OK / throw → `{ kind: "error" }` (API unreachable → render with defaults)
 *
 * `cache: "no-store"` so an organiser edit surfaces immediately (matches the
 * island revalidation + the endpoint's own `cache-control: no-store`).
 */
export async function fetchInvite(slug: string): Promise<InviteFetch> {
  try {
    const res = await fetch(`${API_URL}/api/invite/${encodeURIComponent(slug)}`, {
      cache: "no-store",
    });
    if (res.status === 404) return { kind: "not-found" };
    if (!res.ok) return { kind: "error" };
    return { kind: "ok", invite: (await res.json()) as InviteCustomisation };
  } catch {
    return { kind: "error" };
  }
}

/** Discriminated result of resolving the deployment's primary wedding. */
export type PrimaryWedding = { kind: "ok"; slug: string } | { kind: "none" } | { kind: "error" };

/**
 * Resolve the deployment's primary (default) wedding slug for the bare-domain
 * `/` route, with no build-time slug variable. Hits `GET /api/primary-wedding`,
 * which returns the sole wedding (or the most-recently-created when several
 * exist).
 *
 *  - 200            → `{ kind: "ok", slug }`
 *  - 404            → `{ kind: "none" }` (no wedding configured → neutral state)
 *  - non-OK / throw → `{ kind: "error" }`
 */
export async function fetchPrimaryWedding(): Promise<PrimaryWedding> {
  try {
    const res = await fetch(`${API_URL}/api/primary-wedding`, { cache: "no-store" });
    if (res.status === 404) return { kind: "none" };
    if (!res.ok) return { kind: "error" };
    const body = (await res.json()) as { slug?: unknown };
    if (typeof body.slug === "string" && body.slug.length > 0) {
      return { kind: "ok", slug: body.slug };
    }
    return { kind: "none" };
  } catch {
    return { kind: "error" };
  }
}
