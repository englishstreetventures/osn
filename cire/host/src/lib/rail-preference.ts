/**
 * "Has this organiser collapsed the module rail to its icons?" — one value in
 * `localStorage`, per browser.
 *
 * Per browser rather than per wedding or per account: the choice is about the
 * screen in front of the organiser, not about the wedding on it. A second tab
 * picks a change up the next time it loads; nothing listens for `storage`.
 *
 * Storage is best-effort, and every failure reads as the expanded rail, the
 * portal's default. The portal renders server-side where there is no storage;
 * private-mode Safari throws on `setItem`; a browser with site data blocked
 * throws on reaching `localStorage` at all, which is why the access sits inside
 * the `try` rather than behind a `typeof` guard.
 */

export const RAIL_PREFERENCE_KEY = "cire.host.rail";

const COLLAPSED = "collapsed";

/** True when the organiser last left the rail collapsed. Never throws. */
export function readRailCollapsed(): boolean {
  try {
    return globalThis.localStorage?.getItem(RAIL_PREFERENCE_KEY) === COLLAPSED;
  } catch {
    return false;
  }
}

/** Remember the rail's state. Expanding forgets the key rather than storing a
 *  second value, so the default needs nothing written. Never throws. */
export function writeRailCollapsed(collapsed: boolean): void {
  try {
    if (collapsed) globalThis.localStorage?.setItem(RAIL_PREFERENCE_KEY, COLLAPSED);
    else globalThis.localStorage?.removeItem(RAIL_PREFERENCE_KEY);
  } catch {
    // Storage blocked or full: the rail opens expanded next time.
  }
}
