import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import {
  fetchGiftRegistry,
  giftRegistryAvailabilityCopy,
  giftRegistryBody,
  giftRegistryEyebrow,
  giftRegistryHeading,
  giftRegistryImageBase,
  giftRegistryPath,
  sortGiftRegistryItems,
  type GiftRegistry,
  type GiftRegistryItem,
} from "../../lib/gift-registry";
import { CLAIM_SESSION_EVENT, hasClaimedHint } from "../claim-session";
import { buildSrcSet, variantSrc } from "../invite-images";

/**
 * THE GIFT LIST'S PLACE ON THE INVITE — a short band that says the couple have
 * one, shows a few of the gifts, and links to the page that holds them.
 *
 * The list itself used to render here, at the foot of the invite. It is now its
 * own route (`/<slug>/registry`) because it is the one part of an invitation a
 * guest comes back to, and coming back should not mean scrolling the whole
 * story again. What is left behind has to earn its band: a peek at the actual
 * gifts, not a bare "we have a registry" line.
 *
 * IT RENDERS NOTHING unless the read answers `ok`, and the read is CREDENTIALED:
 * the list is for the couple's guests, so a visitor who has not entered their
 * code gets a 401 and no band at all — the same silence every other section of
 * the invitation keeps behind the claim gate, rather than a band advertising a
 * list they cannot open. A 404 covers a wedding with no registry, one that is
 * not entitled, and one whose list is unpublished: one code, on purpose, so
 * nothing here can be used to tell them apart.
 *
 * THE CLAIM HAPPENS IN THE OTHER ISLAND, and it navigates nowhere — `InvitePage`
 * reveals the invitation in place. So this listens for `CLAIM_SESSION_EVENT` and
 * re-reads: without it, a guest who enters their code would have to reload
 * before the band the couple wrote appeared.
 *
 * NO COUNTS OF WHO. Same rule as the page: the availability line is quantities
 * only. Names and totals are the couple's.
 */

/** How many gifts the peek row shows. The fourth is desktop-only — see below. */
export const GIFT_TEASER_PREVIEW_COUNT = 4;

export interface GiftRegistryTeaserProps {
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

export function GiftRegistryTeaser(props: GiftRegistryTeaserProps) {
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
    // account-wide Workers Free budget of 100k/day (P-W1).
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

  const items = createMemo(() => sortGiftRegistryItems(registry()?.items ?? []));

  /**
   * The peek row: the first few gifts that HAVE a picture, in list order.
   *
   * Pictureless gifts are skipped rather than drawn as empty frames — a row of
   * blank boxes says less than no row at all, and the couple's own order still
   * decides which pictures show.
   */
  const previewItems = createMemo(() =>
    items()
      .filter((item) => item.imageName !== null)
      .slice(0, GIFT_TEASER_PREVIEW_COUNT),
  );

  const eyebrow = createMemo(() => giftRegistryEyebrow(props.eyebrow));
  const heading = createMemo(() => giftRegistryHeading(props.heading, registry()?.headline));
  const body = createMemo(() => giftRegistryBody(props.body, registry()?.message));
  const availabilityCopy = createMemo(() => giftRegistryAvailabilityCopy(items()));

  function imageBase(item: GiftRegistryItem): string {
    // Only ever called for the filtered preview items, which all have a name.
    return giftRegistryImageBase(props.apiUrl, props.slug, item.imageName ?? "");
  }

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
     */
    <div data-gift-teaser-island>
      <Show when={registry()}>
        <section
          data-gift-teaser
          class="border-border border-t px-6 py-16 md:px-8 md:py-20"
          style={{
            ...props.themeVars,
            "background-color": "var(--invite-section-bg)",
          }}
        >
          <div class="mx-auto max-w-[540px] text-center md:max-w-[46rem]">
            <p class="font-body text-gold-ink mb-3 text-[0.72rem] tracking-[0.2em] uppercase">
              {eyebrow()}
            </p>
            <h2 class="font-display text-text mb-5 text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))] leading-[1.15] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]">
              {heading()}
            </h2>

            <Show when={body()}>
              {(text) => (
                <p class="font-body text-text-muted mx-auto mb-8 max-w-[34rem] text-[0.92rem] leading-[1.6] break-words whitespace-pre-line">
                  {text()}
                </p>
              )}
            </Show>

            {/* The peek. Three across on a phone, four from `md` — the fourth
                tile is laid out only where a fourth fits, rather than wrapping
                alone onto a second row and turning a glance into a grid. */}
            <Show when={previewItems().length > 0}>
              {/* `aria-hidden`, because this row IS decoration: the images
                  carry `alt=""` (the gift titles are not shown beside them, and
                  the link below carries the action), so without it assistive
                  tech announces "list, 4 items" and then four empty ones on the
                  way to the only thing here worth reaching. */}
              <ul
                data-gift-teaser-preview
                aria-hidden="true"
                class="mx-auto mb-8 grid max-w-[34rem] list-none grid-cols-3 gap-3 md:grid-cols-4"
              >
                <For each={previewItems()}>
                  {(item, index) => (
                    <li class={index() === 3 ? "hidden md:block" : ""}>
                      <img
                        src={variantSrc(imageBase(item), "thumb")}
                        srcset={buildSrcSet(imageBase(item), ["thumb", "card"])}
                        // A tile is a quarter of a 34rem row at most. `thumb`
                        // (320w) covers it up to 2×; a 3× phone crosses that
                        // and takes `card` (800w). Left alone deliberately: the
                        // variant allowlist is kept small to cap transform-URL
                        // cardinality, and a 480w entry would widen it for a
                        // few lazy below-fold thumbnails.
                        sizes="(min-width: 768px) 8rem, 30vw"
                        alt=""
                        loading="lazy"
                        decoding="async"
                        class="border-border aspect-[4/3] w-full rounded-sm border object-cover"
                      />
                    </li>
                  )}
                </For>
              </ul>
            </Show>

            <a
              data-gift-teaser-link
              href={giftRegistryPath(props.slug)}
              class="border-gold font-body text-gold-ink hover:bg-gold hover:text-bg inline-block rounded-sm border bg-transparent px-6 py-3.5 text-[0.88rem] tracking-[0.12em] uppercase transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
            >
              See the gift list
            </a>

            <Show when={availabilityCopy()}>
              {(copy) => (
                <p
                  data-gift-teaser-availability
                  class="font-body text-text-muted mt-4 text-[0.72rem] tracking-[0.14em] uppercase"
                >
                  {copy()}
                </p>
              )}
            </Show>
          </div>
        </section>
      </Show>
    </div>
  );
}
