import type { InviteCustomisation } from "../designs/types";

/** cire-api origin. Build/runtime env with a local-dev default. */
export const API_URL = import.meta.env.PUBLIC_API_URL ?? "http://localhost:8787";

/** Where `/` sends visitors when `PUBLIC_MARKETING_URL` is unset or unusable. */
export const DEFAULT_MARKETING_URL = "https://cireweddings.com";

/**
 * Resolve the bare-domain (`/`) redirect target from its env value.
 *
 * A plain `??` is NOT enough here, and the failure is severe: `??` falls back
 * only on `undefined`, so an env var present-but-empty (`PUBLIC_MARKETING_URL=`,
 * which is exactly what copying `.env.example` to `.env` produces) survives as
 * `""`. `Astro.redirect("")` emits an empty `Location`, which resolves against
 * the request URL — so `/` redirects to `/`, forever, and the guest site's root
 * is down until someone notices. A relative or non-http(s) value loops or
 * breaks the same way.
 *
 * So anything that isn't an absolute http(s) URL degrades to the production
 * apex. A misconfigured build lands somewhere sensible instead of failing.
 *
 * Taking the raw value as an ARGUMENT rather than reading `import.meta.env`
 * inside is deliberate: the env var is inlined at build time, so a module-level
 * constant is fixed at import and no test can vary it. As a function, every
 * branch is reachable from a table test — the same shape as `apiPreconnectHref`
 * in `./api-origin`.
 */
export function resolveMarketingUrl(raw: string | undefined): string {
  if (typeof raw !== "string" || raw.trim() === "") return DEFAULT_MARKETING_URL;
  try {
    const { protocol, href } = new URL(raw.trim());
    // Relative values never parse (no base), so reaching here means absolute.
    // Only http(s) is navigable; anything else is a misconfigured env var.
    if (protocol !== "http:" && protocol !== "https:") return DEFAULT_MARKETING_URL;
    return href;
  } catch {
    return DEFAULT_MARKETING_URL;
  }
}

/**
 * Marketing-site origin — where the bare domain (`/`) sends visitors, since a
 * multi-tenant guest site has no one wedding to show there.
 */
export const MARKETING_URL = resolveMarketingUrl(import.meta.env.PUBLIC_MARKETING_URL);

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

// NOTE: `fetchPrimaryWedding` used to live here, resolving the bare domain to
// the most-recently-created wedding. It was removed along with the
// `GET /api/primary-wedding` endpoint it called — the bare domain now redirects
// to the marketing site (see `MARKETING_URL` above and `pages/index.astro`).

/**
 * A wedding's invitation page — the route `[slug].astro` serves.
 *
 * Exists because the invite is now linked TO, not only landed on: the gift list
 * lives at its own route (`giftRegistryPath`) and its way home has to be the
 * same string the couple hand out. Encoded for the same reason the API encodes
 * a slug it puts in a URL.
 */
export function invitePath(slug: string): string {
  return `/${encodeURIComponent(slug)}`;
}
