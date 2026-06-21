/**
 * The organiser dashboard's navigable state, encoded in the URL hash so a hard
 * refresh restores exactly where you were and a shared link opens to (almost)
 * the same place the sender was in.
 *
 * Scheme (everything after the `#`):
 *   #/weddings                         → the wedding list
 *   #/weddings/<weddingId>             → that wedding, default tab (events)
 *   #/weddings/<weddingId>/<tab>       → that wedding + a specific tab
 *   #/security                         → the account-security view
 *
 * `<tab>` is one of events | guests | rsvps | invite | codes | hosts. The list view and
 * the security view carry no further state here; deeper sub-state (open modals,
 * a selected guest row) is intentionally NOT deep-linked yet — see the wiki.
 *
 * Anything unrecognised parses to the wedding list, so a stale or hand-edited
 * hash degrades gracefully rather than erroring.
 */

export const DASHBOARD_TABS = ["events", "guests", "rsvps", "invite", "codes", "hosts"] as const;

export type DashboardTab = (typeof DASHBOARD_TABS)[number];

export const DEFAULT_TAB: DashboardTab = "events";

export function isDashboardTab(value: string): value is DashboardTab {
  return (DASHBOARD_TABS as readonly string[]).includes(value);
}

/**
 * The full parsed route. A discriminated union so callers branch on `view`:
 * - `weddings` with no `weddingId` ⇒ the list
 * - `weddings` with a `weddingId` ⇒ that wedding's dashboard on `tab`
 * - `security` ⇒ the security panel
 */
export type DashboardRoute =
  | { view: "weddings"; weddingId: null; tab: DashboardTab }
  | { view: "weddings"; weddingId: string; tab: DashboardTab }
  | { view: "security"; weddingId: null; tab: DashboardTab };

export const LIST_ROUTE: DashboardRoute = {
  view: "weddings",
  weddingId: null,
  tab: DEFAULT_TAB,
};

/** Strip a single leading `#` and any leading/trailing slashes, then split into
 *  path segments. `decodeURIComponent` each so an id with reserved chars round-
 *  trips. Empty/garbage ⇒ `[]`. */
function segments(hash: string): string[] {
  const raw = hash.replace(/^#/, "").replace(/^\/+|\/+$/g, "");
  if (raw === "") return [];
  return raw.split("/").map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      // A malformed %-escape shouldn't throw — keep the raw segment.
      return s;
    }
  });
}

/**
 * Parse a location hash into a {@link DashboardRoute}. Total + defensive:
 * unknown shapes fall back to the wedding list. An owner-only tab on a deep link
 * is NOT gated here (the parser doesn't know the caller's role) — the dashboard
 * resolves the visible tab when it renders.
 */
export function parseRoute(hash: string): DashboardRoute {
  const parts = segments(hash);
  if (parts.length === 0) return LIST_ROUTE;

  if (parts[0] === "security") {
    return { view: "security", weddingId: null, tab: DEFAULT_TAB };
  }

  if (parts[0] === "weddings") {
    const weddingId = parts[1];
    if (!weddingId) return LIST_ROUTE;
    const rawTab = parts[2];
    const tab = rawTab && isDashboardTab(rawTab) ? rawTab : DEFAULT_TAB;
    return { view: "weddings", weddingId, tab };
  }

  return LIST_ROUTE;
}

/** Serialize a route back to a hash string (always leading `#/`). The inverse of
 *  {@link parseRoute} for every route it can produce. */
export function serializeRoute(route: DashboardRoute): string {
  if (route.view === "security") return "#/security";
  if (route.weddingId === null) return "#/weddings";
  const id = encodeURIComponent(route.weddingId);
  // The default tab is left implicit so a wedding link stays short + canonical;
  // an explicit non-default tab is appended.
  if (route.tab === DEFAULT_TAB) return `#/weddings/${id}`;
  return `#/weddings/${id}/${route.tab}`;
}
