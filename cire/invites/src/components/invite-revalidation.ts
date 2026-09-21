import { createResource, type InitializedResource } from "solid-js";

import type { InviteTheme } from "./invite-theme";

/** Events ("details") section header copy. `null` ⇒ the built-in defaults. */
export interface DetailsCopy {
  eyebrow: string | null;
  heading: string | null;
}

/**
 * Shape of the public invite endpoint as the page islands consume it — the theme
 * plus the copy they render (the details-section header and the post-claim
 * welcome greeting). Every field is optional on the wire so a mid-deploy payload
 * from an older API simply keeps the built-in copy.
 *
 * The closing section is deliberately absent: `GET /api/invite/:slug` redacts it
 * (it is addressed to the invited household and arrives in the claim response
 * instead), so a field for it here would describe something that is always null.
 * The header islands consume the wider `InviteCustomisation` from
 * `../designs/types` instead — hence the `Body` type parameter below.
 */
export interface InviteCustomisationResponse {
  theme?: InviteTheme | null;
  details?: DetailsCopy | null;
  welcome?: { message: string | null } | null;
}

export interface InviteRevalidationOptions<Body, T> {
  /** cire-api origin the island fetches from at runtime. */
  apiUrl: () => string;
  /** The wedding slug. Absent ⇒ never fetch; the fallback is used as-is. */
  slug: () => string | undefined;
  /**
   * What to paint when there is nothing fresher: the build-time props. Used as
   * the resource's `initialValue` AND as the result of both failure paths, so a
   * non-OK or thrown revalidation keeps what is already on screen rather than
   * wiping it. A thunk because the failure paths read it after the `await`.
   */
  fallback: () => T;
  /** Narrow the response to the slice this island renders. */
  select: (body: Body) => T;
}

/**
 * The no-store re-request of the invite payload every design pack's islands run.
 *
 * The props seed the resource, so first paint is immediate and the no-JS
 * fallback still renders the server-rendered values; the fresh response then
 * overrides them.
 *
 * Where it runs is not where the name suggests. With no `ssrLoadFrom: "initial"`
 * Solid's server build calls the fetcher during the render, and Astro's Solid
 * renderer awaits it, so this runs in the Worker and hydration reuses the
 * serialised value rather than fetching again. Each island therefore adds a
 * blocking subrequest for a payload the route already fetched and passed in as
 * props.
 *
 * What is shared is the fetch, the `no-store`, the two failure paths and the
 * `initialValue` wiring. What each call site keeps is its own fallback and its
 * own mapping — the headers pass the body through and fall back to their
 * `initial` prop, the pages map three fields out of it and fall back to a value
 * built from three props. Both are right for their caller, so neither is baked
 * in here.
 */
export function createInviteRevalidation<Body, T>(
  options: InviteRevalidationOptions<Body, T>,
): InitializedResource<T> {
  const [data] = createResource<T>(
    async () => {
      const slug = options.slug();
      if (!slug) return options.fallback();
      try {
        // Encoded, like the server-side `fetchInvite` in ../lib/invite.ts: the
        // slug comes off the request path, so encoding is what keeps it one
        // path segment rather than something that can move the request to a
        // different path or query on the API origin.
        const res = await fetch(`${options.apiUrl()}/api/invite/${encodeURIComponent(slug)}`, {
          cache: "no-store",
        });
        if (!res.ok) return options.fallback();
        return options.select((await res.json()) as Body);
      } catch {
        return options.fallback();
      }
    },
    { initialValue: options.fallback() },
  );
  return data;
}
