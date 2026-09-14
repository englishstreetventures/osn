import type { Module } from "./dashboard-route";

/** What a module costs to reach, when the wedding has to pay for it. `title` and
 *  `blurb` are the popover's own copy — the row itself only ever shows the
 *  module's label. */
export interface ModuleLock {
  /** The `wedding_entitlements` key the wedding must hold. */
  entitlement: string;
  /** Popover heading. */
  title: string;
  /** One sentence on what unlocking gives. */
  blurb: string;
}

/** A module's nav entry. `glyph` is a small leading mark that makes the row
 *  scannable; `hint` is its one-line description — a native tooltip on the
 *  rail, visible text in the sheet and the command palette, and the panel
 *  header's subtitle (touch has no hover, so a hover-only hint would be
 *  unreachable on the surface that needs it most). A locked row is the one
 *  exception to the rail tooltip: it carries no `title`, because a native
 *  tooltip appears in well under the dwell its upgrade popover waits for and
 *  the two would race. `lock`, where present, names the entitlement that
 *  unlocks the module. */
export interface ModuleDef {
  id: Module;
  label: string;
  glyph: string;
  hint: string;
  lock?: ModuleLock;
}

/** The module nav, in workflow order: land on Overview, then build the day
 *  (Events) → invite the people (Guests) → dress it up (Invite) → housekeeping
 *  (Settings). Every row is visible to every organiser: a module the wedding is
 *  not entitled to stays in the nav, faded and inert, rather than disappearing.
 *  Read-only gating works the same way — write surfaces are gated inside each
 *  module, not hidden here.
 *
 *  This lives in `lib/` rather than in the sidebar because four surfaces now
 *  read it — the rail, the narrow sheet, the command palette and the Overview
 *  cards — and a module that exists in one but not the others is a bug nobody
 *  notices. */
export const MODULE_NAV: ModuleDef[] = [
  { id: "overview", label: "Overview", glyph: "◈", hint: "Your wedding at a glance" },
  { id: "events", label: "Events", glyph: "◇", hint: "Your ceremony, reception, and more" },
  { id: "checklist", label: "Checklist", glyph: "✓", hint: "Your planning tasks by lead time" },
  { id: "budget", label: "Budget", glyph: "$", hint: "Estimates, quotes, and payments" },
  {
    id: "vendors",
    label: "Vendors",
    glyph: "⬡",
    hint: "Track and book your suppliers",
    lock: {
      entitlement: "vendors",
      title: "Vendors & directory",
      blurb: "Browse trusted wedding vendors and manage your shortlist in one place.",
    },
  },
  {
    id: "registry",
    label: "Registry",
    glyph: "⊞",
    hint: "Your gift list and what has arrived",
    lock: {
      entitlement: "registry",
      title: "Gift registry",
      blurb: "List the gifts you'd like, and see what guests have claimed and sent.",
    },
  },
  { id: "guests", label: "Guests", glyph: "✎", hint: "Households, invites, and RSVPs" },
  { id: "invite", label: "Invite", glyph: "✦", hint: "Photos, story, colours, and codes" },
  { id: "settings", label: "Settings", glyph: "✧", hint: "Profile, budget, and co-hosts" },
];

/** Built once. `moduleDef` is called from the shell's header, its panel keys,
 *  the rail, the sheet and the command palette — a linear scan per call turns
 *  one navigation into dozens of nine-element searches for an answer that never
 *  changes. */
const BY_ID = new Map(MODULE_NAV.map((mod) => [mod.id, mod]));

/** The entry for a module. Falls back to Overview, which is also where an
 *  unparseable route lands, so the two agree. */
export function moduleDef(id: Module): ModuleDef {
  return BY_ID.get(id) ?? MODULE_NAV[0]!;
}

/** Whether this wedding has to upgrade to reach the module. Derived from the
 *  wedding's own entitlement rows, so a wedding that holds the key keeps a
 *  working module and every other one sees the same faded row. */
export function isModuleLocked(id: Module, entitlements: readonly string[]): boolean {
  const { lock } = moduleDef(id);
  return lock !== undefined && !entitlements.includes(lock.entitlement);
}
