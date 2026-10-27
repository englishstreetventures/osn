/**
 * The organiser dashboard's navigable state, encoded in the URL hash so a hard
 * refresh restores exactly where you were and a shared link opens to (almost)
 * the same place the sender was in.
 *
 * Scheme (everything after the `#`) — the module IA shell (PR 3):
 *   #/weddings                              → the wedding list
 *   #/w/<weddingId>                         → that wedding, default module (overview)
 *   #/w/<weddingId>/<module>                → that wedding + a module (default sub)
 *   #/w/<weddingId>/<module>/<sub>          → that wedding + a module + a sub-view
 *   #/w/<weddingId>/guests/rsvps/<eventId>  → the RSVP page, on one event
 *   #/security                              → the account-security view
 *
 * `<module>` is one of {@link MODULES} below, and each module carries an
 * optional `<sub>` (e.g. `guests/rsvps`, `invite/codes`,
 * `settings/hosts`). The RSVP page alone goes one level deeper: it shows one
 * event at a time, and the event it shows is part of the address, so a reload
 * or a shared link opens the same event. Any other page ignores a segment past
 * its sub, and nothing else inside a view (an open modal, a selected row, a
 * sort) is in the address.
 *
 * Anything unrecognised parses to the wedding list, so a stale or hand-edited
 * hash degrades gracefully rather than erroring. The pre-IA `#/weddings/<id>/<tab>`
 * links (bookmarks from before PR 3) are kept working for one release via a
 * legacy-tab → (module, sub) alias — see {@link parseRoute}.
 */

/** The module a wedding dashboard can be showing. Order = sidebar order:
 *  land on Overview, then the day (Events), the planning modules and the day's
 *  run sheet → the people (Guests) and where they sit (Seating) → the invite →
 *  housekeeping (Settings). */
export const MODULES = [
  "overview",
  "events",
  "checklist",
  "run-sheet",
  "budget",
  "vendors",
  "registry",
  "guests",
  "seating",
  "invite",
  "settings",
] as const;

export type Module = (typeof MODULES)[number];

export const DEFAULT_MODULE: Module = "overview";

export function isModule(value: string): value is Module {
  return (MODULES as readonly string[]).includes(value);
}

/**
 * The valid sub-views per module. The FIRST entry is the module's default sub
 * (left implicit in the canonical URL). A module with a single implicit view
 * uses the sentinel `"index"`. Sub-routes that are role-gated (invite/codes is
 * owner-only; the `edit` subs are editor-only) still parse here — the parser
 * can't see the caller's role; the shell resolves the visible sub when it
 * renders. (There is no `guests/import` sub: the CSV import lives INSIDE each
 * module's `edit` sub, not on a route of its own.)
 */
export const MODULE_SUBS = {
  overview: ["index"],
  // Events gains an `edit` sub in E6 (the events editor) alongside the
  // read-only `list` view. `edit` is editor-only.
  events: ["list", "edit"],
  checklist: ["index"],
  // The day, read-only for every role: one view.
  "run-sheet": ["index"],
  budget: ["index"],
  vendors: ["index", "browse", "enquiries"],
  // The gift list the couple authors, then the log of what guests actually
  // claimed and sent. `list` is the default: an empty registry has no gifts to
  // show, and the list is the surface that fixes that.
  registry: ["list", "gifts", "settings"],
  // `edit` is the interactive guest editor (E5), an editor-only sub the shell
  // hides from read-only viewers (the parser can't see the role).
  guests: ["list", "edit", "rsvps"],
  seating: ["index"],
  invite: ["design", "codes"],
  settings: ["wedding", "hosts"],
} satisfies Record<Module, readonly string[]>;

export function defaultSub(module: Module): string {
  return MODULE_SUBS[module][0]!;
}

export function isSubOf(module: Module, sub: string): boolean {
  return (MODULE_SUBS[module] as readonly string[]).includes(sub);
}

/**
 * The full parsed route. A discriminated union so callers branch on `view`:
 * - `weddings` with no `weddingId` ⇒ the list
 * - `weddings` with a `weddingId` ⇒ that wedding's dashboard on `module`/`sub`
 * - `security` ⇒ the security panel
 */
export type DashboardRoute =
  | { view: "weddings"; weddingId: null; module: Module; sub: string }
  | {
      view: "weddings";
      weddingId: string;
      module: Module;
      sub: string;
      /** The event the RSVP page shows. Read and written only on guests/rsvps;
       *  absent, the page shows its first event. */
      rsvpEvent?: string;
    }
  | { view: "security"; weddingId: null; module: Module; sub: string };

/** Whether a module and sub are the RSVP page, the one page whose address
 *  names an event. */
export function isRsvpPage(module: Module, sub: string): boolean {
  return module === "guests" && sub === "rsvps";
}

export const LIST_ROUTE: DashboardRoute = {
  view: "weddings",
  weddingId: null,
  module: DEFAULT_MODULE,
  sub: defaultSub(DEFAULT_MODULE),
};

/** The alias table's shape. Keyed by the raw tab segment off the URL hash, so
 *  the key set is open by construction — an unrecognised segment simply has no
 *  alias. Read it only through an own-key check: as an object literal it also
 *  answers to `constructor`, `toString` and `__proto__`. */
interface LegacyTabAliases {
  readonly [tab: string]: { module: Module; sub: string };
}

/**
 * The pre-IA flat tabs (`events | guests | rsvps | invite | codes | hosts |
 * settings`), mapped to their new (module, sub) home. Kept so an old bookmark —
 * `#/weddings/<id>/rsvps` — still opens to the right place for one release.
 */
const LEGACY_TAB_ALIAS: LegacyTabAliases = {
  events: { module: "events", sub: "list" },
  guests: { module: "guests", sub: "list" },
  rsvps: { module: "guests", sub: "rsvps" },
  invite: { module: "invite", sub: "design" },
  codes: { module: "invite", sub: "codes" },
  hosts: { module: "settings", sub: "hosts" },
  settings: { module: "settings", sub: "wedding" },
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
 * A segment the URL parser would resolve away when it lands in a path.
 * `encodeURIComponent` leaves dots alone, so an id of `..` would turn
 * `/api/organiser/weddings/../x` into `/api/organiser/x`. Checked on the
 * DECODED value: a `%2e` that survives decoding is re-encoded as `%252e`,
 * which is not a dot segment.
 */
export function isDotSegment(segment: string): boolean {
  return segment === "." || segment === "..";
}

/** Resolve a wedding route from a module + an optional raw sub segment. An
 *  unknown sub falls back to the module's default sub rather than erroring, so a
 *  stale `…/invite/bogus` link opens the invite module's default view. */
function weddingRoute(
  weddingId: string,
  module: Module,
  rawSub: string | undefined,
): DashboardRoute {
  if (isDotSegment(weddingId)) return LIST_ROUTE;
  const sub = rawSub && isSubOf(module, rawSub) ? rawSub : defaultSub(module);
  return { view: "weddings", weddingId, module, sub };
}

/**
 * Parse a location hash into a {@link DashboardRoute}. Total + defensive:
 * unknown shapes fall back to the wedding list. Role-gated modules/subs are NOT
 * gated here (the parser doesn't know the caller's role) — the shell resolves
 * the visible module/sub when it renders.
 */
export function parseRoute(hash: string): DashboardRoute {
  const parts = segments(hash);
  if (parts.length === 0) return LIST_ROUTE;

  if (parts[0] === "security") {
    return {
      view: "security",
      weddingId: null,
      module: DEFAULT_MODULE,
      sub: defaultSub(DEFAULT_MODULE),
    };
  }

  // Canonical IA shape: #/w/<id>/<module>/<sub>[/<eventId> on the RSVP page]
  if (parts[0] === "w") {
    const weddingId = parts[1];
    if (!weddingId) return LIST_ROUTE;
    const rawModule = parts[2];
    const module = rawModule && isModule(rawModule) ? rawModule : DEFAULT_MODULE;
    const route = weddingRoute(weddingId, module, parts[3]);
    const rsvpEvent = parts[4];
    // A dot segment is dropped like any id read from the address, though this
    // one only ever selects among the events the API returned.
    if (
      route.weddingId !== null &&
      isRsvpPage(route.module, route.sub) &&
      rsvpEvent &&
      !isDotSegment(rsvpEvent)
    ) {
      return { ...route, rsvpEvent };
    }
    return route;
  }

  // Legacy shape kept alive for one release: #/weddings/<id>/<tab> → (module, sub).
  // A bare #/weddings is the list; #/weddings/<id> alone lands on the default
  // module so an old wedding bookmark still opens.
  if (parts[0] === "weddings") {
    const weddingId = parts[1];
    if (!weddingId) return LIST_ROUTE;
    const rawTab = parts[2];
    // Only the table's own keys alias; any other segment, a name every object
    // inherits included, lands on the default module.
    const alias =
      rawTab && Object.hasOwn(LEGACY_TAB_ALIAS, rawTab) ? LEGACY_TAB_ALIAS[rawTab] : undefined;
    if (alias) return weddingRoute(weddingId, alias.module, alias.sub);
    return weddingRoute(weddingId, DEFAULT_MODULE, undefined);
  }

  return LIST_ROUTE;
}

/** Serialize a route back to a hash string (always leading `#/`). The inverse of
 *  {@link parseRoute} for every CANONICAL route it produces (the legacy
 *  `#/weddings/<id>/<tab>` shape is parse-only — it always serialises to the new
 *  `#/w/…` form so bookmarks migrate forward on first navigation). */
export function serializeRoute(route: DashboardRoute): string {
  if (route.view === "security") return "#/security";
  if (route.weddingId === null) return "#/weddings";
  const id = encodeURIComponent(route.weddingId);
  const onDefaultSub = route.sub === defaultSub(route.module);
  // The default module + default sub are left implicit so a wedding link stays
  // short + canonical; an explicit module and/or non-default sub is appended.
  if (route.module === DEFAULT_MODULE && onDefaultSub) return `#/w/${id}`;
  if (onDefaultSub) return `#/w/${id}/${route.module}`;
  const page = `#/w/${id}/${route.module}/${route.sub}`;
  if (route.rsvpEvent !== undefined && isRsvpPage(route.module, route.sub)) {
    return `${page}/${encodeURIComponent(route.rsvpEvent)}`;
  }
  return page;
}
