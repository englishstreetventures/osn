import { createMemo, createSignal, onCleanup, onMount, type Accessor } from "solid-js";

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

export interface InviteRetryOptions<Body, T> {
  /** cire-api origin the island fetches from. */
  apiUrl: () => string;
  /**
   * The wedding slug to fetch, or `undefined` to fetch nothing. A call site
   * passes it only when the route's own server-side fetch failed; when the
   * island already holds the route's payload there is nothing to retry.
   */
  slug: () => string | undefined;
  /**
   * What to paint until a retry lands, and for good if none does: the island's
   * props. Read live, so the value follows the props store Astro reconciles.
   */
  fallback: () => T;
  /** Narrow the response to the slice this island renders. */
  select: (body: Body) => T;
}

/**
 * The browser-side retry of the invite fetch the `[slug]` route makes.
 *
 * The route fetches the invite once per request and passes it to the islands as
 * props, so an island that has it fetches nothing. When the route's fetch
 * failed, the shell renders with built-in defaults and the island asks again
 * from the browser, once, after it mounts.
 *
 * Three properties the islands depend on:
 *
 * - **Never on the server.** `onMount` does not run in Solid's server build, so
 *   the Worker never makes this request and the HTML never waits on it. A
 *   `createResource` would: without `ssrLoadFrom: "initial"` Solid's server
 *   build calls its fetcher during the render and Astro's renderer awaits it.
 * - **Never suspends.** Astro hydrates every island inside a `Suspense`, and a
 *   resource refetched there would swap the island for the empty fallback while
 *   in flight. A signal filled from `onMount` has no loading state to suspend on.
 * - **A failure writes nothing.** A non-OK response, a thrown fetch or an
 *   unparseable body leaves the value as it was, so its identity holds and no
 *   effect or memo downstream re-runs for data that did not change.
 */
export function createInviteRetry<Body, T>(options: InviteRetryOptions<Body, T>): Accessor<T> {
  const [fetched, setFetched] = createSignal<{ value: T }>();

  onMount(() => {
    const slug = options.slug();
    if (!slug) return;
    const controller = new AbortController();
    onCleanup(() => controller.abort());
    void (async () => {
      try {
        // Encoded, like the server-side `fetchInvite` in ../lib/invite.ts: the
        // slug comes off the request path, so encoding is what keeps it one
        // path segment rather than something that can move the request to a
        // different path or query on the API origin.
        // Credentialed like every other browser call to cire-api, so it rides
        // the connection the document's (credentialed) preconnect opened
        // instead of paying a fresh handshake in front of the hero.
        const res = await fetch(`${options.apiUrl()}/api/invite/${encodeURIComponent(slug)}`, {
          cache: "no-store",
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) return;
        const value = options.select((await res.json()) as Body);
        setFetched({ value });
      } catch {
        // Offline, aborted or not JSON: keep what is painted.
      }
    })();
  });

  return createMemo(() => {
    const landed = fetched();
    return landed ? landed.value : options.fallback();
  });
}
