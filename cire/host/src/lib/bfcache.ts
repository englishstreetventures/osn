/**
 * Reload the page when the browser restores it from the back/forward cache.
 *
 * A bfcache restore brings back the whole page — DOM and JavaScript memory —
 * as it was when the user left, without asking the server. After sign-out,
 * pressing Back would otherwise show the signed-in portal with the account's
 * data still on screen. A reload sends the page back through `RequireAuth`,
 * which redirects a signed-out session to `/login`.
 *
 * `Cache-Control: no-store` on `/` (`public/_headers`) keeps most browsers from
 * caching the page at all, but not every browser honours that for bfcache, so
 * this listener is the half that holds everywhere.
 *
 * Returns the function that removes the listener.
 */
export function reloadOnRestore(win: Window = window): () => void {
  const onPageShow = (event: PageTransitionEvent) => {
    if (event.persisted) win.location.reload();
  };
  win.addEventListener("pageshow", onPageShow);
  return () => win.removeEventListener("pageshow", onPageShow);
}
