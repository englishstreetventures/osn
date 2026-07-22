/**
 * Responsive variant widths the API can transform an invite image to. Mirrors
 * the bounded `IMAGE_VARIANTS` allowlist in `cire/api` — the API resolves an
 * unknown/absent `?variant=` (and any environment without the Cloudflare Images
 * binding) to the original bytes, so the plain `src` below always works as a
 * progressive fallback even when `srcset` is ignored or transforms are off.
 *
 * `hero-bg` is the 1600px hero width rendered with a SERVER-SIDE blur (the radius
 * is a server constant — `VARIANT_BLUR` in `cire/api`, never sent from here): the
 * soft full-bleed backdrop the hero title sits over. The blur abstracts detail,
 * so one width is enough for the backdrop — no responsive `srcset` needed.
 */
export const VARIANT_WIDTHS = { thumb: 320, card: 800, hero: 1600, "hero-bg": 1600 } as const;
export type VariantName = keyof typeof VARIANT_WIDTHS;

// The hero backdrop always requests the `hero-bg` variant: the blur radius is now
// a per-wedding server value (migration 0018; 0 ⇒ the server renders it sharp),
// so the guest never picks a different variant — one fixed-purpose variant keeps
// the re-arm lifecycle + cache simple.
export const HERO_BG_VARIANT: VariantName = "hero-bg";

/**
 * Build a `srcset` from a base image URL (which already carries the `?v=`
 * content-version cache-buster) by appending the bounded `&variant=` for each
 * width in `variants`. The browser picks the entry matching the rendered size +
 * DPR; the API negotiates WebP/AVIF per request via Accept.
 */
export function buildSrcSet(baseUrl: string, variants: readonly VariantName[]): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return variants.map((v) => `${baseUrl}${sep}variant=${v} ${VARIANT_WIDTHS[v]}w`).join(", ");
}

/**
 * Point a base image URL at a single bounded `variant` (no width descriptor — for
 * a fixed-purpose `src`, like the blurred hero backdrop). The variant name is the
 * only thing appended; the blur radius lives server-side, keyed off the variant.
 */
export function variantSrc(baseUrl: string, variant: VariantName): string {
  const sep = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${sep}variant=${variant}`;
}
