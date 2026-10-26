/**
 * What the gift list looks like wherever it is shown: its section copy, its
 * order, its page address and its picture URLs. No request is made here.
 *
 * Apart from the client (`gift-registry.ts`) because the invitation's band
 * needs only these, and the band is what a guest of a wedding with a list
 * downloads once the list read answers; the claim, release and money calls
 * stay on the gift list's own page.
 */

import { giftRegistryBase, type GiftRegistryItem } from "./gift-registry-read";

/** The wedding's gift-list page. Encoded like every other slug in a URL here. */
export function giftRegistryPath(slug: string): string {
  return `/cire/registry?slug=${encodeURIComponent(slug)}`;
}

/** Built-in copy when the organiser set none. */
export const DEFAULT_GIFT_REGISTRY_EYEBROW = "With Love";
export const DEFAULT_GIFT_REGISTRY_HEADING = "Gift Registry";

/**
 * First usable line of copy, or `null`.
 *
 * Blank counts as unset, not as an answer: a `??` chain takes the first
 * NON-NULL value, so a heading saved as `""` would beat both the registry
 * module's own headline and the built-in default — an empty `<h1>` on the
 * invite, and on the gift page an empty `<title>` in the browser tab and in
 * every link preview of it.
 */
function firstCopy(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

/** Section eyebrow — the invite's copy, else the built-in. */
export function giftRegistryEyebrow(inviteCopy: string | null | undefined): string {
  return firstCopy(inviteCopy) ?? DEFAULT_GIFT_REGISTRY_EYEBROW;
}

/**
 * Section heading. The invite's own copy wins when the organiser wrote it (it is
 * section furniture, themed with every other section header); the registry
 * module's `headline` fills in when they only wrote copy there.
 */
export function giftRegistryHeading(
  inviteCopy: string | null | undefined,
  headline: string | null | undefined,
): string {
  return firstCopy(inviteCopy, headline) ?? DEFAULT_GIFT_REGISTRY_HEADING;
}

/** Intro body, same precedence as the heading. `null` ⇒ render no paragraph. */
export function giftRegistryBody(
  inviteCopy: string | null | undefined,
  message: string | null | undefined,
): string | null {
  return firstCopy(inviteCopy, message);
}

/**
 * Sort as the API's own index does: `sort_order`, then `id` as the tie-break.
 * Re-sorted client-side rather than trusted, so a merged/refetched list is
 * stable no matter what order the rows arrived in. Copies — never sorts the
 * caller's array in place. Gifts and cash funds share one order on the list,
 * so it sorts either, or both together.
 */
export function sortGiftRegistryItems<T extends Pick<GiftRegistryItem, "id" | "sortOrder">>(
  items: readonly T[],
): T[] {
  // oxlint-disable-next-line unicorn/no-array-sort -- sorts a copy; `toSorted` is above this site's browser floor (Firefox 114, Safari 16.4 in `.browserslistrc`).
  return [...items].sort((a, b) =>
    a.sortOrder === b.sortOrder ? a.id.localeCompare(b.id) : a.sortOrder - b.sortOrder,
  );
}

/**
 * Base URL for an item's image, with NO `?variant=` yet — feed it to the shared
 * `variantSrc` / `buildSrcSet` helpers, which own the bounded variant names and
 * their widths for every image on the guest site.
 *
 * `imageName` is the LAST SEGMENT of the R2 key; the route rebuilds the rest
 * server-side from the slug, so the guest never names a bucket path.
 */
export function giftRegistryImageBase(apiUrl: string, slug: string, imageName: string): string {
  return `${giftRegistryBase(apiUrl, slug)}/image/${encodeURIComponent(imageName)}`;
}
