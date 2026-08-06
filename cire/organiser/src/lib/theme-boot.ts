/**
 * The theme boot script, and the two constants it shares with `lib/theme.ts`.
 *
 * Its own module, with no imports, because `.astro` frontmatter pulls it into
 * the *build*: a page that imported `lib/theme.ts` for this string would drag
 * SolidJS and a module-scope signal graph into Astro's server bundle to render
 * a `<script>` tag. Nothing here has a dependency, so nothing here can fail at
 * build time.
 */

export type Theme = "dark" | "light";

export const THEME_STORAGE_KEY = "cire.host.theme";

/** Dark is the house look, so it is what an unresolvable preference falls back to. */
export const DEFAULT_THEME: Theme = "dark";

export const LIGHT_QUERY = "(prefers-color-scheme: light)";

/**
 * Inlined in `<head>` on every page, before the stylesheet has any say.
 *
 * It has to run before first paint. A host who chose light and gets one frame
 * of dark has been flashbanged in the other direction — which is the whole
 * thing the light ramp was tuned to avoid — and the Solid island that owns the
 * preference doesn't mount until long after that frame. So: no framework, no
 * module, one attribute, synchronously.
 *
 * Every failure resolves to a theme rather than an exception. `localStorage`
 * throws outright in some private-browsing modes, and a browser with no
 * `matchMedia` is simply given the house dark.
 */
export const THEME_BOOT_SCRIPT =
  `(function(){var p=null;` +
  `try{p=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)})}catch(e){}` +
  `var t=(p==="light"||p==="dark")?p` +
  `:(window.matchMedia&&window.matchMedia(${JSON.stringify(LIGHT_QUERY)}).matches` +
  `?"light":${JSON.stringify(DEFAULT_THEME)});` +
  `document.documentElement.setAttribute("data-theme",t)})()`;
