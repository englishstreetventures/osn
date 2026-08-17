import type { Module } from "./dashboard-route";

/** A module's nav entry. `glyph` is a small leading mark that makes the row
 *  scannable; `hint` is its one-line description — a native tooltip on the
 *  rail, visible text in the sheet and the command palette, and the panel
 *  header's subtitle (touch has no hover, so a hover-only hint would be
 *  unreachable on the surface that needs it most). */
export interface ModuleDef {
  id: Module;
  label: string;
  glyph: string;
  hint: string;
}

/** The module nav, in workflow order: land on Overview, then build the day
 *  (Events) → invite the people (Guests) → dress it up (Invite) → housekeeping
 *  (Settings). Every module has a read view, so the whole nav is visible to
 *  viewers; write-only surfaces are gated inside each module, not hidden here.
 *
 *  This lives in `lib/` rather than in the sidebar because three surfaces now
 *  read it — the rail, the narrow sheet, and the command palette — and a
 *  module that exists in one but not the others is a bug nobody notices. */
export const MODULE_NAV: ModuleDef[] = [
  { id: "overview", label: "Overview", glyph: "◈", hint: "Your wedding at a glance" },
  { id: "events", label: "Events", glyph: "◇", hint: "Your ceremony, reception, and more" },
  { id: "checklist", label: "Checklist", glyph: "✓", hint: "Your planning tasks by lead time" },
  { id: "budget", label: "Budget", glyph: "$", hint: "Estimates, quotes, and payments" },
  { id: "vendors", label: "Vendors", glyph: "⬡", hint: "Track and book your suppliers" },
  { id: "registry", label: "Registry", glyph: "⊞", hint: "Your gift list and what has arrived" },
  { id: "guests", label: "Guests", glyph: "✎", hint: "Households, invites, and RSVPs" },
  { id: "invite", label: "Invite", glyph: "✦", hint: "Photos, story, colours, and codes" },
  { id: "settings", label: "Settings", glyph: "✧", hint: "Profile, budget, and co-hosts" },
];

/** The entry for a module. Falls back to Overview, which is also where an
 *  unparseable route lands, so the two agree. */
export function moduleDef(id: Module): ModuleDef {
  return MODULE_NAV.find((mod) => mod.id === id) ?? MODULE_NAV[0]!;
}
