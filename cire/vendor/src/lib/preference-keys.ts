import { themeBootScript } from "@cire/ui/lib/theme-boot";

/**
 * The vendor portal's storage keys, and the theme boot script that reads the
 * first of them.
 *
 * Its own module, importing nothing but the import-free boot script, because
 * the `.astro` pages pull it into the *build*: a page that imported
 * `preferences.ts` for this string would drag SolidJS and a signal graph into
 * Astro's server bundle to render a `<script>` tag.
 *
 * Namespaced to this portal, not shared with the host portal's
 * `cire.host.*`. They could not share a value even if the names matched —
 * `localStorage` is partitioned by origin and the two portals are two hosts —
 * so a shared name would only promise a continuity it cannot deliver.
 * Distinct names say that outright.
 */

export const THEME_STORAGE_KEY = "cire.vendor.theme";

export const HAPTICS_STORAGE_KEY = "cire.vendor.haptics";

/** Inlined in `<head>` on every page, so the theme is on `<html>` before first paint. */
export const THEME_BOOT_SCRIPT = themeBootScript(THEME_STORAGE_KEY);
