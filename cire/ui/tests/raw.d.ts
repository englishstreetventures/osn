/**
 * Vite's `?raw` suffix imports a file's text as a string. Declared here rather
 * than through `vite/client`, so this package's one TypeScript program loads no
 * library beyond the guest site's browser floor.
 */
declare module "*?raw" {
  const source: string;
  export default source;
}

/**
 * A browser test imports `test-support/tailwind.css` for its side effect, the
 * stand-in stylesheet. Declared here for the same reason as `?raw`.
 */
declare module "*.css";

/**
 * An `.astro` component, as the `astro` test project imports one to render it
 * with Astro's container API. Declared here for the same reason as `?raw`:
 * `astro/client`'s types would load a library past the browser floor.
 */
declare module "*.astro" {
  const component: import("astro/runtime/server/index.js").AstroComponentFactory;
  export default component;
}
