/**
 * How a wedding's display name becomes the base of its slug.
 *
 * This file imports nothing. The marketing site (`cire/landing`) previews the
 * slug a couple would get as they type their names, and its test imports this
 * file directly to hold its copy of the rule equal to this one; an import here
 * would pull the database or Effect into that site's test run.
 */

/** Max display-name length accepted from the organiser portal. */
export const MAX_DISPLAY_NAME = 120;

/**
 * Derive a URL-safe base slug from a display name: lowercase, ASCII-ish, words
 * joined by single hyphens. Empty input (e.g. an all-emoji name) falls back to
 * `"wedding"` so we always have something to suffix.
 */
export function slugifyDisplayName(displayName: string): string {
  const base = displayName
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
