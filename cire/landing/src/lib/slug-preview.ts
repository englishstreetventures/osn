/**
 * The closing field's link preview: the slug cire-api would make from the
 * names a couple type, and the link that carries those names to the organiser
 * portal.
 *
 * `slugPreview` is a copy of `slugifyDisplayName` in
 * `cire/api/src/lib/slug.ts`. The site cannot import it at build time without
 * reaching into another package's source, so it keeps its own and
 * `tests/lib/slug-preview.test.ts` holds the two equal on a corpus of names.
 * Change one and the test says to change the other.
 */

/** The longest name cire-api accepts, in UTF-16 units, as `maxlength` counts them. */
export const MAX_NAME_LENGTH = 120;

/** The base slug cire-api makes from a display name; Cire appends six characters of its own. */
export function slugPreview(name: string): string {
  const base = name
    .normalize("NFKD")
    // Drop combining marks left by NFKD so "José" → "jose", not "jose<mark>".
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return base.length > 0 ? base : "wedding";
}

/**
 * The organiser portal, with the names as `?name=` when there are any. The
 * portal opens its create form with them; it never submits on its own.
 */
export function claimHref(organiserUrl: string, name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) return organiserUrl;
  return `${organiserUrl.replace(/\/+$/, "")}/?name=${encodeURIComponent(trimmed)}`;
}
