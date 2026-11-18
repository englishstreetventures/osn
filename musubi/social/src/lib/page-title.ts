import { createEffect, onCleanup } from "solid-js";

import { PRODUCT_NAME } from "./auth";

/** The page that set the title last; only it may change or give back the title. */
let owner: symbol | null = null;

/**
 * Names the browser tab, the history entry and a bookmark after the page:
 * `"<title> · Musubi"`, or `"Musubi"` alone while `title` is empty. A page
 * passes its own `h1` text.
 *
 * The router can mount the next page before it disposes the last one, so the
 * title belongs to the page that set it most recently. The last page's title
 * changing after that (its organisation loading late, say) leaves the tab
 * alone, and its unmount does not wipe the next page's title. When the page
 * that owns the title goes, the title goes back to `"Musubi"`.
 */
export function usePageTitle(title: () => string | undefined): void {
  const me = Symbol("page-title");
  let first = true;
  createEffect(() => {
    const text = title();
    if (first) {
      first = false;
      owner = me;
    } else if (owner !== me) {
      return;
    }
    document.title = text ? `${text} · ${PRODUCT_NAME}` : PRODUCT_NAME;
  });
  onCleanup(() => {
    if (owner !== me) return;
    owner = null;
    document.title = PRODUCT_NAME;
  });
}
