import { themeBootScript } from "@cire/ui/lib/theme-boot";

/**
 * The host portal's storage keys, and the theme boot script that reads the
 * first of them.
 *
 * Its own module, importing nothing but the import-free boot script, because
 * the `.astro` pages pull it into the *build*: a page that imported
 * `preferences.ts` for this string would drag SolidJS and a signal graph into
 * Astro's server bundle to render a `<script>` tag.
 */

export const THEME_STORAGE_KEY = "cire.host.theme";

export const HAPTICS_STORAGE_KEY = "cire.host.haptics";

/** Inlined in `<head>` on every page, so the theme is on `<html>` before first paint. */
export const THEME_BOOT_SCRIPT = themeBootScript(THEME_STORAGE_KEY);
