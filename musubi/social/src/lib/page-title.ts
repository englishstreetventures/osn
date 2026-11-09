import { createEffect, onCleanup } from "solid-js";

import { PRODUCT_NAME } from "./auth";

/** The page that set the title last; only it may give the title back. */
let owner: symbol | null = null;

/**
 * Names the browser tab, the history entry and a bookmark after the page:
 * `"<title> · Musubi"`, or `"Musubi"` alone while `title` is empty. A page
 * passes its own `h1` text.
 *
 * When the page goes, the title goes back to `"Musubi"` — unless the next
 * page has already set its own, which the router can do before it disposes
 * the last one.
 */
export function usePageTitle(title: () => string | undefined): void {
  const me = Symbol("page-title");
  createEffect(() => {
    const text = title();
    owner = me;
    document.title = text ? `${text} · ${PRODUCT_NAME}` : PRODUCT_NAME;
  });
  onCleanup(() => {
    if (owner !== me) return;
    owner = null;
    document.title = PRODUCT_NAME;
  });
}
