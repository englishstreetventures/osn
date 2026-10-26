/**
 * THE ISLAND BEHIND THE GIFT BAND — the list read, and nothing else of the gift
 * list until that read answers with one. Both design packs mount it below the
 * invitation; the band itself is `GiftRegistryTeaser`.
 *
 * IT RENDERS NOTHING unless the read answers `ok`, and the read is CREDENTIALED:
 * the list is for the couple's guests, so a visitor who has not entered their
 * code gets a 401 and no band at all — the same silence every other section of
 * the invitation keeps behind the claim gate, rather than a band advertising a
 * list they cannot open. A 404 covers a wedding with no registry, one that is
 * not entitled, and one whose list is unpublished: one code, on purpose, so
 * nothing here can be used to tell them apart.
 *
 * THE BAND IS DOWNLOADED ONLY FOR A LIST. The gift list is a Gold module, and the
 * public invite payload carries no plan on purpose, so this read is the only way
 * the invitation learns whether there is a band to show. Until it answers `ok`,
 * the band's markup and the gift-list client it imports (`lib/gift-registry.ts`)
 * stay out of the page: `lazy` asks for their chunk the first time the band
 * renders, and nothing preloads it, because a preload beside the read would
 * download it for every guest of a wedding without a list. A guest of a wedding
 * with one waits for a second round trip instead, below the fold.
 *
 * A band chunk that fails to download throws out of this island, as the
 * invitation's other lazy panels do, and `lazy` keeps that failed import, so
 * the band stays away until the page is reloaded.
 *
 * THE CLAIM HAPPENS IN THE OTHER ISLAND, and it navigates nowhere — `InvitePage`
 * reveals the invitation in place. So this listens for `CLAIM_SESSION_EVENT` and
 * re-reads: without it, a guest who enters their code would have to reload
 * before the band the couple wrote appeared.
 */
import { createSignal, lazy, onCleanup, onMount, Show, Suspense, type Component } from "solid-js";

import { fetchGiftRegistry, type GiftRegistry } from "../../lib/gift-registry-read";
import { CLAIM_SESSION_EVENT, hasClaimedHint } from "../claim-session";
import type { GiftRegistryTeaserProps } from "./GiftRegistryTeaser";

// Module scope, so every render shares one promise and therefore one chunk. A
// `.then` adapter because `lazy` wants a default export and this one is named.
//
// Left out of the server build: the server never renders the band, because its
// list comes only from a credentialed read the browser makes after hydration.
const GiftRegistryTeaser: Component<GiftRegistryTeaserProps> = import.meta.env.SSR
  ? () => null
  : lazy(() => import("./GiftRegistryTeaser").then((m) => ({ default: m.GiftRegistryTeaser })));

export interface GiftRegistryTeaserIslandProps {
  /** cire-api origin. */
  apiUrl: string;
  /** The wedding this invite renders. */
  slug: string;
  /** Section copy from the invite payload; `null` ⇒ the built-in default. */
  eyebrow?: string | null;
  heading?: string | null;
  body?: string | null;
  /** Validated CSS-variable map for this section's surface (`sectionVars(theme, "registry")`). */
  themeVars?: Record<string, string>;
}

export function GiftRegistryTeaserIsland(props: GiftRegistryTeaserIslandProps) {
  // `null` means "no band". Until the read answers `ok` this component renders
  // NOTHING — the state for a visitor who has not claimed (401), and the
  // permanent one for a registry that is unpublished, unentitled or absent
  // (404, one code for all three).
  const [registry, setRegistry] = createSignal<GiftRegistry | null>(null);

  async function load(): Promise<void> {
    // NO HINT, NO CALL. The read is credentialed now, so for a browser that has
    // never claimed here it can only ever answer 401 — and this band sits on a
    // PUBLIC invite that every visitor scrolls past: first-timers, link
    // previews, every share of the couple's link. Without this guard the wasted
    // request scales with page views rather than with guests, against an
    // account-wide Workers Free budget of 100k/day.
    //
    // Safe against the one case that matters: `noteClaimed()` sets the hint
    // BEFORE it dispatches `CLAIM_SESSION_EVENT`, so a guest entering their
    // code still gets the band in place with no reload. Hint and session are
    // minted by the same claim, last the same 30 days, and are cleared
    // together; forging the hint buys only the 401 it would have got anyway.
    if (!hasClaimedHint()) {
      setRegistry(null);
      return;
    }
    const result = await fetchGiftRegistry(props.apiUrl, props.slug);
    // Only an `ok` changes what is on screen. A 401 before a claim and a 401
    // after a session lapses are the same answer — no band — and a transport
    // failure must not take away a band that is already reading.
    if (result.kind === "ok") setRegistry(result.registry);
    else if (result.kind === "signed-out" || result.kind === "hidden") setRegistry(null);
  }

  onMount(() => {
    void load();
    const onSessionChange = () => void load();
    window.addEventListener(CLAIM_SESSION_EVENT, onSessionChange);
    onCleanup(() => window.removeEventListener(CLAIM_SESSION_EVENT, onSessionChange));
  });

  return (
    /**
     * AN ALWAYS-PRESENT ELEMENT ROOT, and it must stay one.
     *
     * `client:visible` does not observe the island; it observes the island's
     * element CHILDREN (`for (const child of el.children) io.observe(child)` in
     * astro's `runtime/client/visible.js`), because `<astro-island>` is
     * `display: contents` and has no box of its own to intersect with.
     *
     * Everything below is inside `<Show when={registry()}>`, and the registry is
     * `null` until a credentialed fetch that only runs after hydration — so on the server this
     * component renders nothing, the island ships zero element children, the
     * observer is handed nothing to watch and hydration NEVER fires. The whole
     * band is then absent from both design packs, in production only: a unit
     * test renders the component directly and never sees it.
     *
     * This wrapper is that box. It has no class and no style: an empty `<div>`
     * adds no layout, while a bare `<section>` here would paint a visible empty
     * bordered, padded band on every wedding without a gift list.
     *
     * The `Suspense` is this island's own, and it must stay inside the wrapper.
     * The Solid integration wraps every hydrated island in a `Suspense` of its
     * own; without this one, the band's chunk loading would suspend that outer
     * boundary and take the wrapper off the page while it loads.
     */
    <div data-gift-teaser-island>
      <Show when={registry()}>
        {(list) => (
          <Suspense fallback={null}>
            <GiftRegistryTeaser
              apiUrl={props.apiUrl}
              slug={props.slug}
              registry={list()}
              eyebrow={props.eyebrow}
              heading={props.heading}
              body={props.body}
              themeVars={props.themeVars}
            />
          </Suspense>
        )}
      </Show>
    </div>
  );
}
