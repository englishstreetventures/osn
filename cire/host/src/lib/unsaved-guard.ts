/**
 * A tiny cross-component "unsaved changes" registry. A form with local edit
 * buffers (today: the invite builder) registers a dirty-check while mounted;
 * the dashboard's SPA navigation (`OrganiserApp.setRoute`) asks
 * `confirmNavigation()` before switching views, so an organiser can't lose a
 * half-written invite to a stray module click. Browser `beforeunload` (tab
 * close / reload) is the registering component's own responsibility — this
 * guard only covers in-app navigation, and browser Back/Forward deliberately
 * bypasses it (re-pushing a vetoed history entry is worse than the loss it
 * prevents).
 *
 * One guard at a time is enough: only one write surface is mounted per route.
 */

type DirtyCheck = () => boolean;

let activeGuard: DirtyCheck | null = null;

/** Register a dirty-check. Returns the unregister function — call it in
 *  `onCleanup` so an unmounted form can never veto navigation. */
export function registerUnsavedGuard(isDirty: DirtyCheck): () => void {
  activeGuard = isDirty;
  return () => {
    if (activeGuard === isDirty) activeGuard = null;
  };
}

/** True when navigation may proceed: no guard, a clean form, or the user
 *  explicitly confirmed discarding their edits. */
export function confirmNavigation(
  message = "You have unsaved invite changes. Leave without saving?",
): boolean {
  if (!activeGuard || !activeGuard()) return true;
  if (typeof window === "undefined") return true;
  return window.confirm(message);
}
