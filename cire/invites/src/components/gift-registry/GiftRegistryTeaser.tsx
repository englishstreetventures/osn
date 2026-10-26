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
 * IT IS NOT THE ISLAND. `GiftRegistryTeaserIsland` makes the list read and
 * imports this module only once that read answers with a list, so a guest of a
 * wedding with no list for them (below Gold, unpublished, or none at all) never
 * downloads the band, nor the display helpers it imports. `registry` is that
 * answer.
 *
 * NO COUNTS AT ALL. Same rule as the page: the band says the couple have a list
 * and shows a few of the gifts on it. How many are left, and who took them, are
 * the couple's.
 */
import { createMemo, For, Show } from "solid-js";

import {
  giftRegistryBody,
  giftRegistryEyebrow,
  giftRegistryHeading,
  giftRegistryImageBase,
  giftRegistryPath,
  sortGiftRegistryItems,
} from "../../lib/gift-registry-display";
import type { GiftRegistry } from "../../lib/gift-registry-read";
import { buildSrcSet, variantSrc } from "../invite-images";

/** How many gifts the peek row shows. The fourth is desktop-only — see below. */
export const GIFT_TEASER_PREVIEW_COUNT = 4;

export interface GiftRegistryTeaserProps {
  /** cire-api origin. */
  apiUrl: string;
  /** The wedding this invite renders. */
  slug: string;
  /** The list read's answer, when it was a list. */
  registry: GiftRegistry;
  /** Section copy from the invite payload; `null` ⇒ the built-in default. */
  eyebrow?: string | null;
  heading?: string | null;
  body?: string | null;
  /** Validated CSS-variable map for this section's surface (`sectionVars(theme, "registry")`). */
  themeVars?: Record<string, string>;
}

export function GiftRegistryTeaser(props: GiftRegistryTeaserProps) {
  /**
   * The peek row: the first few gifts and cash funds that HAVE a picture, in
   * the couple's order (`sortOrder`, then `id`, as the API's own index sorts).
   *
   * Pictureless ones are skipped rather than drawn as empty frames — a row of
   * blank boxes says less than no row at all, and the couple's own order still
   * decides which pictures show. Funds arrive only while the couple take
   * money, so a fund's picture here is one a guest can give to.
   */
  const previewItems = createMemo(() =>
    sortGiftRegistryItems([...props.registry.items, ...(props.registry.funds ?? [])])
      .filter((entry) => entry.imageName !== null)
      .slice(0, GIFT_TEASER_PREVIEW_COUNT),
  );

  const eyebrow = createMemo(() => giftRegistryEyebrow(props.eyebrow));
  const heading = createMemo(() => giftRegistryHeading(props.heading, props.registry.headline));
  const body = createMemo(() => giftRegistryBody(props.body, props.registry.message));

  function imageBase(item: { imageName: string | null }): string {
    // Only ever called for the filtered preview items, which all have a name.
    return giftRegistryImageBase(props.apiUrl, props.slug, item.imageName ?? "");
  }

  return (
    <section
      data-gift-teaser
      class="border-border border-t px-6 py-16 md:px-8 md:py-20"
      style={{
        ...props.themeVars,
        "background-color": "var(--invite-section-bg)",
      }}
    >
      <div class="md:max-w-ui-xl max-w-column-lg mx-auto text-center">
        <p class="font-body text-gold-ink text-ui-xs tracking-ui-widest mb-3 uppercase">
          {eyebrow()}
        </p>
        <h2 class="font-display text-text leading-ui-none mb-5 text-[calc(clamp(2rem,5vw,3rem)*var(--invite-heading-scale,1))] [font-weight:var(--invite-heading-weight,300)] [font-style:var(--invite-heading-style,normal)]">
          {heading()}
        </h2>

        <Show when={body()}>
          {(text) => (
            <p class="font-body text-text-muted text-ui-base leading-ui-normal max-w-ui-md mx-auto mb-8 break-words whitespace-pre-line">
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
            class="max-w-ui-md mx-auto mb-8 grid list-none grid-cols-3 gap-3 md:grid-cols-4"
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
                    class="border-border aspect-4/3 w-full rounded-sm border object-cover"
                  />
                </li>
              )}
            </For>
          </ul>
        </Show>

        <a
          data-gift-teaser-link
          href={giftRegistryPath(props.slug)}
          class="border-gold font-body text-gold-ink hover:bg-gold hover:text-on-gold text-ui-base tracking-ui-wider inline-block rounded-sm border bg-transparent px-6 py-3.5 uppercase transition-colors duration-200 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--invite-focus)]"
        >
          See the gift list
        </a>
      </div>
    </section>
  );
}
