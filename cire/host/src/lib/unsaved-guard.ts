import type { DashboardRoute } from "./dashboard-route";

/**
 * A tiny cross-component "unsaved changes" registry. A form with local edit
 * buffers (the invite builder, the guest and event editors) registers a
 * dirty-check while mounted; the dashboard's SPA navigation
 * (`OrganiserApp.setRoute`) asks `confirmNavigation({ next })` before switching
 * views, so an organiser can't lose a half-written invite to a stray module
 * click. Browser `beforeunload` (tab close / reload) is the registering
 * component's own responsibility — this guard only covers in-app navigation,
 * and browser Back/Forward deliberately bypasses it (re-pushing a vetoed
 * history entry is worse than the loss it prevents).
 *
 * A form that stays mounted across several routes — the invite builder across
 * the Invite module's four views — says which with `keeps`, so moving between
 * them never asks.
 *
 * One guard at a time is enough: only one write surface is mounted per route.
 */

type DirtyCheck = () => boolean;

interface Guard {
  isDirty: DirtyCheck;
  keeps?: (next: DashboardRoute) => boolean;
}

let activeGuard: Guard | null = null;

/** Register a dirty-check, and optionally the routes the form stays mounted
 *  on. Returns the unregister function — call it in `onCleanup` so an
 *  unmounted form can never veto navigation. */
export function registerUnsavedGuard(
  isDirty: DirtyCheck,
  keeps?: (next: DashboardRoute) => boolean,
): () => void {
  const guard: Guard = { isDirty, keeps };
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}

/** True when navigation may proceed: no guard, a clean form, a move to a route
 *  the form stays mounted on, or the user explicitly confirmed discarding their
 *  edits. Without `next` the move is never one the form keeps. */
export function confirmNavigation(
  options: { message?: string; next?: DashboardRoute } = {},
): boolean {
  if (!activeGuard || !activeGuard.isDirty()) return true;
  if (options.next && activeGuard.keeps?.(options.next)) return true;
  if (typeof window === "undefined") return true;
  return window.confirm(
    options.message ?? "You have unsaved invite changes. Leave without saving?",
  );
}
