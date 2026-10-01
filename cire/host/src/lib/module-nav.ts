import type { LucideIcon } from "lucide-solid";
import CalendarDays from "lucide-solid/icons/calendar-days";
import Gift from "lucide-solid/icons/gift";
import ListChecks from "lucide-solid/icons/list-checks";
import MailOpen from "lucide-solid/icons/mail-open";
import PiggyBank from "lucide-solid/icons/piggy-bank";
import Settings from "lucide-solid/icons/settings";
import Store from "lucide-solid/icons/store";
import Users from "lucide-solid/icons/users";

import NestedDiamondIcon from "../components/NestedDiamondIcon";
import type { Module } from "./dashboard-route";
import { type PaidTier, type Tier, tierAtLeast } from "./tiers";

/** What a module costs to reach, when the wedding has to pay for it. `title` and
 *  `blurb` are the popover's own copy — the row itself only ever shows the
 *  module's label. */
export interface ModuleLock {
  /** The lowest tier that includes the module — the API's tier gate for the
   *  module's routes names the same one. */
  tier: PaidTier;
  /** Popover heading. */
  title: string;
  /** One sentence on what unlocking gives. */
  blurb: string;
}

/** A module's nav entry. `icon` is a small leading mark that makes the row
 *  scannable, drawn through `ModuleIcon` so every surface sizes it alike; `hint` is its one-line description — a native tooltip on the
 *  rail, visible text in the sheet and the command palette, and the panel
 *  header's subtitle (touch has no hover, so a hover-only hint would be
 *  unreachable on the surface that needs it most). A locked row is the one
 *  exception to the rail tooltip: it carries no `title`, because a native
 *  tooltip appears in well under the dwell its upgrade popover waits for and
 *  the two would race. `lock`, where present, names the tier that
 *  unlocks the module. */
export interface ModuleDef {
  id: Module;
  label: string;
  icon: LucideIcon;
  hint: string;
  lock?: ModuleLock;
}

/** The module nav, in workflow order: land on Overview, then build the day
 *  (Events) → invite the people (Guests) → dress it up (Invite) → housekeeping
 *  (Settings). Every row is visible to every organiser: a module the wedding's
 *  tier does not include stays in the nav, faded and inert, rather than
 *  disappearing.
 *  Read-only gating works the same way — write surfaces are gated inside each
 *  module, not hidden here.
 *
 *  This lives in `lib/` rather than in the sidebar because four surfaces now
 *  read it — the rail, the narrow sheet, the command palette and the Overview
 *  cards — and a module that exists in one but not the others is a bug nobody
 *  notices. */
export const MODULE_NAV: ModuleDef[] = [
  { id: "overview", label: "Overview", icon: NestedDiamondIcon, hint: "Your wedding at a glance" },
  {
    id: "events",
    label: "Events",
    icon: CalendarDays,
    hint: "Your ceremony, reception, and more",
  },
  {
    id: "checklist",
    label: "Checklist",
    icon: ListChecks,
    hint: "Your planning tasks by lead time",
    lock: {
      tier: "gold",
      title: "Planning checklist",
      blurb: "Every task in order of lead time, so nothing is left to the last week.",
    },
  },
  {
    id: "budget",
    label: "Budget",
    icon: PiggyBank,
    hint: "Estimates, quotes, and payments",
    lock: {
      tier: "gold",
      title: "Budget",
      blurb: "Track estimates, quotes and payments against your total, and see what is due next.",
    },
  },
  {
    id: "vendors",
    label: "Vendors",
    icon: Store,
    hint: "Track and book your suppliers",
    lock: {
      tier: "crimson",
      title: "Vendors & directory",
      blurb: "Browse trusted wedding vendors and manage your shortlist in one place.",
    },
  },
  {
    id: "registry",
    label: "Registry",
    icon: Gift,
    hint: "Your gift list and what has arrived",
    lock: {
      tier: "gold",
      title: "Gift registry",
      blurb: "List the gifts you'd like, and see what guests have claimed and sent.",
    },
  },
  { id: "guests", label: "Guests", icon: Users, hint: "Households, invites, and RSVPs" },
  { id: "invite", label: "Invite", icon: MailOpen, hint: "Photos, story, colours, and codes" },
  { id: "settings", label: "Settings", icon: Settings, hint: "Profile, budget, and co-hosts" },
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
 *  wedding's tier alone, so a wedding on the module's tier or above keeps a
 *  working module and every other one sees the same faded row. */
export function isModuleLocked(id: Module, tier: Tier): boolean {
  const { lock } = moduleDef(id);
  return lock !== undefined && !tierAtLeast(tier, lock.tier);
}
