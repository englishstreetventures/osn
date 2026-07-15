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
 *   #/security                              → the account-security view
 *
 * `<module>` is one of overview | guests | schedule | invite | settings, and each
 * module carries an optional `<sub>` (e.g. `guests/rsvps`, `invite/codes`,
 * `settings/hosts`). Deeper sub-state (open modals, a selected row) is
 * intentionally NOT deep-linked yet — see the wiki.
 *
 * Anything unrecognised parses to the wedding list, so a stale or hand-edited
 * hash degrades gracefully rather than erroring. The pre-IA `#/weddings/<id>/<tab>`
 * links (bookmarks from before PR 3) are kept working for one release via a
 * legacy-tab → (module, sub) alias — see {@link parseRoute}.
 */

/** The module a wedding dashboard can be showing. Order = sidebar order:
 *  land on Overview, then the day (Schedule) → the people (Guests) → the invite
 *  → housekeeping (Settings). */
export const MODULES = ["overview", "guests", "schedule", "invite", "settings"] as const;

export type Module = (typeof MODULES)[number];

export const DEFAULT_MODULE: Module = "overview";

export function isModule(value: string): value is Module {
  return (MODULES as readonly string[]).includes(value);
}

/**
 * The valid sub-views per module. The FIRST entry is the module's default sub
 * (left implicit in the canonical URL). A module with a single implicit view
 * uses the sentinel `"index"`. Sub-routes that are role-gated (invite/codes is
 * owner-only, guests/import is editor-only) still parse here — the parser can't
 * see the caller's role; the shell resolves the visible sub when it renders.
 */
export const MODULE_SUBS: Record<Module, readonly string[]> = {
  overview: ["index"],
  // `edit` is the interactive guest editor (E5), an editor-only sub the shell
  // hides from read-only viewers (the parser can't see the role).
  guests: ["list", "edit", "rsvps"],
  // Schedule gains an `edit` sub in E6 (the events editor) alongside the
  // read-only `list` view (the old Events tab). `edit` is editor-only.
  schedule: ["list", "edit"],
  invite: ["design", "codes"],
  settings: ["wedding", "hosts"],
};

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
  | { view: "weddings"; weddingId: string; module: Module; sub: string }
  | { view: "security"; weddingId: null; module: Module; sub: string };

export const LIST_ROUTE: DashboardRoute = {
  view: "weddings",
  weddingId: null,
  module: DEFAULT_MODULE,
  sub: defaultSub(DEFAULT_MODULE),
};

/**
 * The pre-IA flat tabs (`events | guests | rsvps | invite | codes | hosts |
 * settings`), mapped to their new (module, sub) home. Kept so an old bookmark —
 * `#/weddings/<id>/rsvps` — still opens to the right place for one release.
 */
const LEGACY_TAB_ALIAS: Record<string, { module: Module; sub: string }> = {
  events: { module: "schedule", sub: "list" },
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

/** Resolve a wedding route from a module + an optional raw sub segment. An
 *  unknown sub falls back to the module's default sub rather than erroring, so a
 *  stale `…/invite/bogus` link opens the invite module's default view. */
function weddingRoute(
  weddingId: string,
  module: Module,
  rawSub: string | undefined,
): DashboardRoute {
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

  // Canonical IA shape: #/w/<id>/<module>/<sub>
  if (parts[0] === "w") {
    const weddingId = parts[1];
    if (!weddingId) return LIST_ROUTE;
    const rawModule = parts[2];
    const module = rawModule && isModule(rawModule) ? rawModule : DEFAULT_MODULE;
    return weddingRoute(weddingId, module, parts[3]);
  }

  // Legacy shape kept alive for one release: #/weddings/<id>/<tab> → (module, sub).
  // A bare #/weddings is the list; #/weddings/<id> alone lands on the default
  // module so an old wedding bookmark still opens.
  if (parts[0] === "weddings") {
    const weddingId = parts[1];
    if (!weddingId) return LIST_ROUTE;
    const rawTab = parts[2];
    const alias = rawTab ? LEGACY_TAB_ALIAS[rawTab] : undefined;
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
  return `#/w/${id}/${route.module}/${route.sub}`;
}
