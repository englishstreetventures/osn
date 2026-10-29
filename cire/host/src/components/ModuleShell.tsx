import BriefcaseBusiness from "lucide-solid/icons/briefcase-business";
import Compass from "lucide-solid/icons/compass";
import Gift from "lucide-solid/icons/gift";
import House from "lucide-solid/icons/house";
import IdCard from "lucide-solid/icons/id-card";
import Inbox from "lucide-solid/icons/inbox";
import KeyRound from "lucide-solid/icons/key-round";
import List from "lucide-solid/icons/list";
import MailCheck from "lucide-solid/icons/mail-check";
import PackageCheck from "lucide-solid/icons/package-check";
import Palette from "lucide-solid/icons/palette";
import PencilLine from "lucide-solid/icons/pencil-line";
import Settings2 from "lucide-solid/icons/settings-2";
import UsersRound from "lucide-solid/icons/users-round";
import {
  type Component,
  createComputed,
  createEffect,
  createMemo,
  createSignal,
  For,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  Suspense,
} from "solid-js";

import { createAutoSize } from "../lib/auto-size";
import { peekCachedBudget } from "../lib/budget-store";
import { DEFAULT_MODULE, defaultSub, isSubOf, type Module } from "../lib/dashboard-route";
import { isModuleLocked, moduleDef } from "../lib/module-nav";
import { scrollDelta } from "../lib/scroll-to-results";
import { createSlidingPill } from "../lib/sliding-pill";
import type { PaidTier, Tier } from "../lib/tiers";
import type { WeddingRole } from "../lib/wedding-roles";
import { TipLayer, TipTrigger } from "./ActionTip";
import BudgetView from "./BudgetView";
import ChecklistView from "./ChecklistView";
import EditWorkspace from "./EditWorkspace";
import EventTable from "./EventTable";
import GuestTable from "./GuestTable";
import HostsPanel from "./HostsPanel";
// Type only, and as a whole `import type` statement: under
// `verbatimModuleSyntax` an inline `type` specifier leaves a bare import of the
// module behind, which would pull the lazy builder into this eager chunk.
import type { InviteSectionId } from "./invite/InviteBuilder";
import InviteMessageLinks, { type InviteMessagePlace } from "./InviteMessageLinks";
import ModuleSidebar from "./ModuleSidebar";
import Overview from "./Overview";
import PanelLoading from "./PanelLoading";
import RemintPanel from "./RemintPanel";
import RsvpView from "./RsvpView";
import SettingsPanel from "./SettingsPanel";
import { ViewBarContext, type ViewBarContextValue, type ViewBarSlot } from "./ViewBar";

/**
 * The three big write surfaces, split out of the first load.
 *
 * The portal is one `client:only` island, so everything a module might show
 * used to arrive before the Overview could paint — including the invite builder
 * (its own tree plus every design in `@cire/invite-designs`) and the events
 * editor. None of the three is on the path to the page an organiser actually
 * lands on, and two of them are closed to a viewer entirely. They now arrive
 * when the sub-tab that shows them is chosen.
 *
 * The rest stay eager on purpose: they are the read views, they are small, and
 * a rail click that pauses is a worse trade than the bytes.
 */
const loadEventsEditor = () => import("./EventsEditor");
const loadGuestsEditor = () => import("./GuestsEditor");
const loadInviteBuilder = () => import("./InviteBuilder");

/**
 * The registry and vendors modules, split out for a different reason than the
 * three above.
 *
 * They are read views, so by the rule above they would stay eager. They don't,
 * because the shell coerces a locked module to Overview: an organiser whose
 * tier does not include one does not merely see an upsell in the module's
 * place, they cannot reach the module at all. Eager-loading the registry's tree
 * and money formatting, or the vendors module's three panels and its enquiry
 * dialogs, for an organiser who provably cannot open either is paying for a
 * view that will not be shown. Where the tier includes them the cost lands on
 * the rail click that opens the module, warmed by the hover on the sub-tab
 * through `PANEL_LOADERS` below.
 *
 * A chunk per surface rather than per module, because the sub-tabs of both are
 * different things an organiser rarely wants at once. Vendors is a CRM table, a
 * directory browser and an enquiry inbox. The registry's list and gifts-received
 * are two panels of one component and so share a chunk, but its settings tab is
 * its own file — its bytes stay out of the way of the couple who only came to
 * add a gift.
 */
const loadRegistry = () => import("./RegistryView");
const loadRegistrySettings = () => import("./RegistrySettingsView");
const loadVendors = () => import("./VendorsView");
const loadDirectoryBrowse = () => import("./DirectoryBrowseView");
const loadEnquiries = () => import("./EnquiriesView");
/** The seating chart, split out for the registry's reason: it is a Gold module,
 *  so an organiser whose tier does not include it never pays for it. */
const loadSeating = () => import("./SeatingView");
/** The run sheet, for the same reason. A helper's seat (`OrganiserApp`) loads
 *  the same chunk, so its store stays the one the checklist marks stale. Like
 *  the seating chart it has no sub-tabs, so nothing warms it ahead of a click. */
const loadRunSheet = () => import("./RunSheetView");

const EventsEditor = lazy(loadEventsEditor);
const GuestsEditor = lazy(loadGuestsEditor);
const InviteBuilder = lazy(loadInviteBuilder);
const RegistryView = lazy(loadRegistry);
const RegistrySettingsView = lazy(loadRegistrySettings);
const VendorsView = lazy(loadVendors);
const DirectoryBrowseView = lazy(loadDirectoryBrowse);
const EnquiriesView = lazy(loadEnquiries);
const SeatingView = lazy(loadSeating);
const RunSheetView = lazy(loadRunSheet);

/**
 * What one of those chunks resolves to: a panel, default-exported.
 *
 * The warm-up below never reads the module — it only wants the fetch started —
 * but `unknown` here would let anything at all be listed as a panel loader, and
 * a `lazy()` above and a warmer down here would then disagree about what the
 * same chunk is. `Component<never>` accepts any props (a component's props are
 * contravariant), so each panel keeps its own shape while the map still refuses
 * a module that has no component to mount.
 */
type PanelModule = { readonly default: Component<never> };

/**
 * The warm-up table's shape. Keyed `module:sub`, and the sub half is an open
 * string, so the key set is open — a pair with no lazy panel simply has no
 * loader. The module half is TYPED so a stale module segment fails `tsc`
 * rather than going quiet. The lookup below is `?.()` over a
 * swallowed rejection, so a key naming a module that no longer exists
 * produces no error, no warning and no failing test — the only symptom is
 * that hovering the tab stops warming the chunk and every click pays the
 * full round trip behind `PanelLoading`, which is precisely the "first-load
 * win turned into a first-interaction stall" this map exists to prevent.
 * The `events`-for-`schedule` rename this file just went through is exactly
 * that hazard. The template-literal type catches half of it here;
 * `ModuleShell.test.tsx` pins the sub half, which types can't reach.
 */
interface PanelLoaders {
  readonly [key: `${Module}:${string}`]: (() => Promise<PanelModule>) | undefined;
}

/**
 * Which sub-tab hides which chunk, so pointing at one can start its fetch.
 *
 * Deferring the bytes is the point of the split; paying for them on the click
 * rather than on the intent is what would turn a first-load win into a
 * first-interaction stall. A hover or a keyboard focus on the sub-tab is enough
 * warning to cover the round trip, and by the time the click lands the module is
 * usually resolved — so the panel mounts without the fallback below ever
 * painting. The module registry dedupes, so warming twice costs nothing and
 * warming a chunk that is already in costs nothing either.
 */
const PANEL_LOADERS: PanelLoaders = {
  "events:edit": loadEventsEditor,
  "guests:edit": loadGuestsEditor,
  "invite:design": loadInviteBuilder,
  "registry:list": loadRegistry,
  "registry:gifts": loadRegistry,
  "registry:settings": loadRegistrySettings,
  "vendors:index": loadVendors,
  "vendors:browse": loadDirectoryBrowse,
  "vendors:enquiries": loadEnquiries,
};

/** The map's keys, for the drift guard in `ModuleShell.test.tsx`. */
export const PANEL_LOADER_KEYS = Object.keys(PANEL_LOADERS);

function warmPanel(module: Module, sub: string): void {
  // Fire and forget: a failed prefetch is not an error, it just means the real
  // mount pays the cost it would have paid anyway.
  void PANEL_LOADERS[`${module}:${sub}`]?.().catch(() => {});
}

interface ModuleShellProps {
  weddingId: string;
  weddingName: string;
  weddingSlug: string;
  /** The signed-in organiser's role here. The host panel asks it what they may
   *  grant; everything else reads the two flags below, which come from it. */
  callerRole: WeddingRole;
  /** An owner of this wedding? Owners get the destructive/owner-only sub-views
   *  (invite/codes, settings save, host management). */
  canManage: boolean;
  /** Owner or editor co-host? Editors get the module write surfaces (invite
   *  design, import, events/guests editors) plus the RSVP-by date on the
   *  otherwise owner-only settings panel; a viewer co-host is read-only. */
  canEdit: boolean;
  /** Active module — controlled by the parent (URL-hash driven). */
  module: Module;
  /** Active sub-view within the module — controlled by the parent. */
  sub: string;
  /** Report a module switch up so the parent updates the hash — onto `sub`
   *  when given and the module has it, else the module's default sub. One
   *  call, one route write. */
  onModule: (module: Module, sub?: string) => void;
  /** Report a sub-view switch up so the parent updates the hash. */
  onSub: (sub: string) => void;
  /** The event the RSVP page shows, from the hash. Absent: its first event. */
  rsvpEvent?: string;
  /** Report the RSVP page's event switch up so the parent updates the hash. */
  onRsvpEvent?: (eventId: string) => void;
  onWeddingUpdated?: (patch: { displayName: string; slug: string }) => void;
  /** An owner deleted the wedding from Settings (restorable until the ISO date). */
  onWeddingDeleted?: (restoreUntil: string) => void;
  /** An owner redeemed an unlock code from Settings; the wedding is on `tier` now. */
  onTierRaised?: (tier: PaidTier) => void;
  /** The organiser left this wedding from the co-host panel. */
  onLeftWedding?: () => void;
  /** The organiser changed their own role from the co-host panel. */
  onOwnRoleChanged?: (role: WeddingRole) => void;
  /** The wedding's plan tier (from the API list response). A module the tier
   *  does not include is locked: its nav row fades and offers the upgrade, and
   *  the module itself never renders — the shell coerces it to Overview. */
  tier: Tier;
  /** Entitlement keys on this wedding, from the same response. The invite
   *  builder reads `premium_templates` from them to lock premium designs;
   *  nothing else here does. */
  entitlements: string[];
  /** The tier's guest ceiling. Surfaced for informational display —
   *  enforcement is server-side. */
  guestCap: number;
}

/** A sub-tab within a module. `manage`/`edit` mark role-gated subs so a viewer
 *  or non-owner never sees (or reaches, via a stale deep link) a write-only
 *  view. */
interface SubDef {
  id: string;
  label: string;
  /** Drawn before the label, and alone where the panel is too narrow for the
   *  words (the label is then the tab's tooltip and stays its name). */
  icon: Component<{ class?: string; strokeWidth?: number; "aria-hidden"?: "true" }>;
  /** Owner-only sub (e.g. invite/codes). */
  manage?: boolean;
  /** Editor-or-owner sub (hidden from read-only viewers). */
  edit?: boolean;
}

/** The sub-tab table's shape. Every key is a {@link Module} and every module is
 *  optional — the ones with a single view (Overview, Checklist) are absent, and
 *  a lookup for them yields `undefined`. */
interface ModuleSubTabs extends Partial<Record<Module, SubDef[]>> {}

const MODULE_SUB_TABS: ModuleSubTabs = {
  events: [
    { id: "list", label: "List", icon: List },
    { id: "edit", label: "Edit", icon: PencilLine, edit: true },
  ],
  vendors: [
    { id: "index", label: "My vendors", icon: BriefcaseBusiness },
    { id: "browse", label: "Browse", icon: Compass },
    { id: "enquiries", label: "Enquiries", icon: Inbox },
  ],
  registry: [
    { id: "list", label: "Gift list", icon: Gift },
    { id: "gifts", label: "Gifts received", icon: PackageCheck },
    // `edit`, not `manage`: a co-host with edit rights may publish the list and
    // write its copy. The one owner-only control — connecting the account gifts
    // are paid into — is disabled inside the panel with the reason, rather than
    // hiding a whole tab from someone who is allowed most of it.
    { id: "settings", label: "Settings", icon: Settings2, edit: true },
  ],
  guests: [
    { id: "list", label: "Households", icon: House },
    { id: "edit", label: "Edit", icon: PencilLine, edit: true },
    { id: "rsvps", label: "RSVPs", icon: MailCheck },
  ],
  invite: [
    { id: "design", label: "Design", icon: Palette, edit: true },
    { id: "codes", label: "Codes", icon: KeyRound, manage: true },
  ],
  settings: [
    { id: "wedding", label: "Profile", icon: IdCard },
    { id: "hosts", label: "Co-hosts", icon: UsersRound },
  ],
};

/** Below this panel width the sub-tabs show their icons alone. Measured: three
 *  labelled tabs and a view's controls share one row down to about here. */
const ICON_TABS_BELOW_PX = 36 * 16;

/** Where each of the invite message's places lives. `section` is the invite
 *  builder section to open on arrival — builder state that is not in the URL. */
interface InviteMessageRoute {
  module: Module;
  sub: string;
  section?: InviteSectionId;
}

const INVITE_MESSAGE_ROUTES = {
  message: { module: "invite", sub: "design", section: "invite-message" },
  codes: { module: "invite", sub: "codes" },
  households: { module: "guests", sub: "list" },
} satisfies Readonly<Record<InviteMessagePlace, InviteMessageRoute>>;

/** Tab and panel ids are derived from the module so the pair can never point at
 *  a stale partner: switching module re-mints both in the same render. */
const tabId = (module: Module, sub: string) => `subtab-${module}-${sub}`;
const panelId = (module: Module) => `subpanel-${module}`;

/**
 * The per-wedding module shell — the IA replacement for the flat DashboardTabs.
 * A left module rail (Overview / Events / Guests / Invite / Settings) plus,
 * inside a module that has them, a row of sub-tabs. The active module + sub are
 * controlled by the parent (OrganiserApp owns the URL hash so a deep link /
 * hard refresh restores the exact view), reported back via `onModule` / `onSub`.
 *
 * Role handling mirrors the old tabs: viewers get read views everywhere and the
 * write-only subs are hidden; the owner-only invite/codes sub is not selectable
 * for co-hosts even via a stale deep link — {@link resolveSub} falls it back to
 * the module's default sub so the panel is never blank.
 */
export default function ModuleShell(props: ModuleShellProps) {
  // The module actually rendered. A locked one becomes Overview here and
  // nowhere else, so the guarantee is total: every read below — the header, the
  // sub-tabs, the prefetch, every panel and the rail's active row — goes
  // through this, and no route the parent supplies can render a module this
  // wedding has not paid for. The hash is left alone; the parent owns it, and
  // pushing history from a render path invites loops.
  // A memo rather than a plain accessor. Every per-module read below goes
  // through this — the header, the sub-tabs, the panel ids, the prefetch and
  // nine `Show` conditions — and `active()` reaches it twice more through
  // `resolveSub`, so a sub-tab click would otherwise re-derive the same answer
  // dozens of times and wake every one of those `Show` conditions with it.
  const module = createMemo<Module>(() =>
    isModuleLocked(props.module, props.tier) ? DEFAULT_MODULE : props.module,
  );

  // The visible sub-tabs for the current module, filtered by role. Overview and
  // Checklist have no sub-tabs (single view), so they return [].
  const subTabs = (): SubDef[] => {
    const defs = MODULE_SUB_TABS[module()] ?? [];
    return defs.filter((s) => {
      if (s.manage && !props.canManage) return false;
      if (s.edit && !props.canEdit) return false;
      return true;
    });
  };

  // Resolve the visible sub: an unknown sub, or a role-gated one the caller can't
  // see, falls back to the module's default (or the first visible sub-tab).
  const resolveSub = (): string => {
    const sub = props.sub;
    const visible = subTabs();
    if (visible.length === 0) return defaultSub(module());
    // A sub the caller isn't allowed to see (viewer on invite/design, co-host on
    // invite/codes) → first visible tab.
    const allowed = visible.some((s) => s.id === sub);
    if (allowed) return sub;
    if (isSubOf(module(), sub) && !allowed) return visible[0]!.id;
    // Unknown sub entirely.
    return visible[0]!.id;
  };

  const active = () => resolveSub();

  // The builder section an invite-message link asked for, handed to the
  // builder as it mounts. Cleared as soon as the view is anything other than
  // Invite → Design, so a later visit by the rail or a tab opens on the first
  // section as usual. Tracks the view only: setting it never clears it.
  const [builderSection, setBuilderSection] = createSignal<InviteSectionId>();
  createEffect(
    on([module, active], ([m, sub]) => {
      if (m !== "invite" || sub !== "design") setBuilderSection(undefined);
    }),
  );

  let heading: HTMLHeadingElement | undefined;
  /** The shell's root: `--bar-h` is written here, so every view inherits it. */
  let shellEl: HTMLDivElement | undefined;
  /** A box at the bar's resting place, `--chrome-h` tall: its top above its
   *  own height is the bar stuck under the top bar. Present with or without a
   *  bar, so a module with none still knows where the chrome's foot is. */
  let sentinel: HTMLDivElement | undefined;
  let frameEl: HTMLDivElement | undefined;
  let barContent: HTMLDivElement | undefined;

  /** Where the stuck chrome ends: the top bar, plus the view bar when the
   *  module has one, at the height the bar is settling to. */
  function stackFoot(): number {
    const chrome = sentinel?.offsetHeight ?? 0;
    return barContent?.isConnected
      ? chrome + barContent.getBoundingClientRect().height + 1
      : chrome;
  }

  /** Whether the header has scrolled away under the top bar. */
  function isStuck(): boolean {
    if (!sentinel?.isConnected) return false;
    return sentinel.getBoundingClientRect().top < sentinel.offsetHeight - 0.5;
  }

  /**
   * Follow one of the invite-message links. One route write: a module change
   * carries its sub, so the move never passes through the module's default
   * view, and a refused move (the builder's unsaved-changes prompt) is not
   * asked about twice.
   *
   * The parent writes the route synchronously, so straight after the call the
   * view is either the target or — refused — unchanged. Only a move that
   * landed takes focus to the new view's heading; the link that was clicked
   * has just unmounted with the view it sat in. Focus moves without the
   * browser's own scroll, which would put the heading under the top bar; the
   * page then brings the heading to the foot of the chrome if it is above it,
   * which overrides the panel jump a view change makes.
   */
  function openInviteMessagePlace(place: InviteMessagePlace) {
    const to: InviteMessageRoute = INVITE_MESSAGE_ROUTES[place];
    setBuilderSection(to.section);
    if (to.module !== module()) props.onModule(to.module, to.sub);
    else if (to.sub !== active()) props.onSub(to.sub);
    if (module() === to.module && active() === to.sub && heading) {
      heading.focus({ preventScroll: true });
      const move = scrollDelta(heading.getBoundingClientRect().top, sentinel?.offsetHeight ?? 0);
      if (move !== 0) window.scrollBy({ top: move, behavior: "instant" });
    }
  }

  /** The invite-message line for one place, wired to this shell's roles and
   *  navigation. A fresh element per call — each leaf renders its own. */
  const inviteMessageLinks = (here: InviteMessagePlace) => (
    <InviteMessageLinks
      here={here}
      canEdit={props.canEdit}
      canManage={props.canManage}
      onNavigate={openInviteMessagePlace}
    />
  );

  // The panel takes the height of whatever view the tabs swapped in, and moves
  // between the two rather than jumping. Nothing is held at rest — see the note
  // in `auto-size.ts` for why that matters on a panel this general.
  const panelSize = createAutoSize();

  // ── The view bar's contract with the views (`ViewBar.tsx`) ───────────────
  // The panel's width, which decides each view's narrow layout and whether the
  // sub-tabs show their words. Read once, synchronously, as the shell mounts,
  // before anything paints — a view draws nothing list-shaped until it is
  // known — and then followed.
  const [panelWidth, setPanelWidth] = createSignal<number | null>(null);
  let panelEl: HTMLDivElement | undefined;
  onMount(() => {
    if (!panelEl) return;
    setPanelWidth(panelEl.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setPanelWidth(entry.contentRect.width);
    });
    observer.observe(panelEl);
    onCleanup(() => observer.disconnect());
  });
  const iconTabs = () => {
    const width = panelWidth();
    return width !== null && width < ICON_TABS_BELOW_PX;
  };

  const [endMount, setEndMount] = createSignal<HTMLElement>();
  const [row2Mount, setRow2Mount] = createSignal<HTMLElement>();

  // A sub-tab or module change keeps the new panel at least a screen tall
  // until its view says its data is in, so the page cannot clamp while it
  // loads. A view that holds nothing lets go on the next frame.
  const [holding, setHolding] = createSignal(false);
  let holds = 0;
  function hold(): () => void {
    holds += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holds -= 1;
      if (holds === 0) setHolding(false);
    };
  }

  const viewBar: ViewBarContextValue = {
    mount: (slot: ViewBarSlot) => (slot === "end" ? endMount() : row2Mount()),
    panelWidth,
    hold,
  };

  // On a change of view, the page moves once, at once, so the new panel's top
  // sits at the foot of the stuck chrome — but only when the chrome is stuck:
  // a host who has not scrolled sees nothing move. Whether it was stuck is read
  // before the DOM changes (a computation runs ahead of the render), and the
  // move after it, with the panel already held open.
  let wasStuck = false;
  createComputed(
    on(
      [module, active],
      () => {
        wasStuck = isStuck();
        setHolding(true);
      },
      { defer: true },
    ),
  );
  createEffect(
    on(
      [module, active],
      () => {
        if (wasStuck && frameEl) {
          const move = frameEl.getBoundingClientRect().top - stackFoot();
          if (move !== 0) window.scrollBy({ top: move, behavior: "instant" });
        }
        requestAnimationFrame(() => {
          if (holds === 0) setHolding(false);
        });
      },
      { defer: true },
    ),
  );

  /**
   * The bar itself: the sub-tabs, then the two places a view's controls go.
   * Its own component so its height animation and its `--bar-h` writer are
   * made when the bar mounts and disposed with it — a module with one view
   * has no bar, and a stale `--bar-h` would hold every layer below it down.
   */
  function ShellBar() {
    const size = createAutoSize();
    let bar: HTMLElement | undefined;

    // Roving tabindex: only the selected tab is in the tab order, and the arrow
    // keys move focus between the rest. Refs are indexed by position in the
    // current module's visible tabs — a module switch rewrites every entry the
    // handler can reach, so a stale ref past the new length is never read.
    const tabRefs: HTMLButtonElement[] = [];

    // The strip's selected background, as one box that travels rather than one
    // per tab that switches on and off.
    const pill = createSlidingPill(active);

    function focusTab(index: number) {
      const count = subTabs().length;
      if (count === 0) return;
      tabRefs[((index % count) + count) % count]?.focus();
    }

    function onTabKeyDown(event: KeyboardEvent, index: number) {
      // Focus only — Enter and Space fall through to the button's native click,
      // which is what actually selects. Moving through the strip must not mount
      // (and fetch for) a view the host is only passing over.
      if (event.key === "ArrowRight") {
        event.preventDefault();
        focusTab(index + 1);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        focusTab(index - 1);
      } else if (event.key === "Home") {
        event.preventDefault();
        focusTab(0);
      } else if (event.key === "End") {
        event.preventDefault();
        focusTab(subTabs().length - 1);
      }
    }

    // `--bar-h` is the height the bar settles at: its content's, which changes
    // once when a view adds or drops a row, plus the hairline under it. Not the
    // section's own box, which animates through every frame of the slide — each
    // write restyles the whole shell, and the layers below need only the end.
    // A write equal to the last is skipped.
    onMount(() => {
      const content = barContent;
      if (!bar || !content) return;
      const hairline = parseFloat(getComputedStyle(bar).borderBottomWidth) || 0;
      let written: string | undefined;
      const write = () => {
        const value = `${content.getBoundingClientRect().height + hairline}px`;
        if (value === written) return;
        written = value;
        shellEl?.style.setProperty("--bar-h", value);
      };
      write();
      const observer = new ResizeObserver(write);
      observer.observe(content, { box: "border-box" });
      onCleanup(() => {
        observer.disconnect();
        written = undefined;
        shellEl?.style.removeProperty("--bar-h");
      });
    });
    onCleanup(() => {
      setEndMount(undefined);
      setRow2Mount(undefined);
      barContent = undefined;
    });

    return (
      // One landmark, named for the module, outside the module's tab panel:
      // the sub-tabs still control the panel, and a view's controls here still
      // name the part of the view they act on. A named `<section>` is a region.
      <section
        ref={bar}
        aria-label={`${moduleDef(module()).label} controls`}
        data-view-bar
        class="border-border bg-bg sticky top-(--chrome-h) z-20 mb-6 border-b"
      >
        {/* Its height moves with the panel's, through the same helper, so a
            change of view that adds or drops a row of controls never jumps. */}
        <div ref={size.frame}>
          <div
            ref={(el) => {
              barContent = el;
              size.content(el);
            }}
            class="flow-root"
          >
            <div class="flex items-center gap-2 py-2">
              {/* Manual activation (arrows move focus, Enter/Space selects):
                  every panel behind these mounts a fetching view, so
                  selection-follows-focus would fire a request per keypress. */}
              <div
                ref={pill.track}
                class="border-border bg-surface/30 relative inline-flex shrink-0 gap-1 rounded-sm border p-1"
                role="tablist"
                aria-label="Views"
              >
                {/* The selection, as a box that moves. It sits behind the tabs
                    (they are `relative`, it is not stacked over them), so it
                    reads as the selected tab's own background. */}
                <span
                  aria-hidden="true"
                  class="bg-gold/12 pointer-events-none absolute top-0 left-0 rounded-sm"
                  style={pill.style()}
                />
                <For each={subTabs()}>
                  {(subTab, index) => (
                    <TipTrigger
                      label={subTab.label}
                      tipDisabled={!iconTabs()}
                      ref={(el: HTMLButtonElement) => {
                        // Two things want this element: the roving tabindex,
                        // which reaches tabs by position, and the pill, which
                        // reaches them by id. One ref, both told.
                        tabRefs[index()] = el;
                        pill.item(subTab.id)(el);
                      }}
                      role="tab"
                      id={tabId(module(), subTab.id)}
                      aria-controls={panelId(module())}
                      aria-selected={active() === subTab.id}
                      tabindex={active() === subTab.id ? 0 : -1}
                      onKeyDown={(event: KeyboardEvent) => onTabKeyDown(event, index())}
                      onPointerEnter={() => warmPanel(module(), subTab.id)}
                      onFocus={() => warmPanel(module(), subTab.id)}
                      onClick={() => props.onSub(subTab.id)}
                      class={`font-body text-ui-xs tracking-ui-wider transition-ui-colors relative flex items-center gap-2 rounded-sm py-1.5 whitespace-nowrap uppercase duration-(--dur-fast) ease-(--ease-out) ${
                        iconTabs() ? "px-3.5" : "px-3"
                      } ${
                        active() === subTab.id
                          ? "text-gold"
                          : "text-text-muted hover:text-text hover:bg-surface/60"
                      }`}
                    >
                      <subTab.icon
                        aria-hidden="true"
                        strokeWidth={1.75}
                        class="size-3.5 shrink-0"
                      />
                      <span class={iconTabs() ? "sr-only" : undefined}>{subTab.label}</span>
                    </TipTrigger>
                  )}
                </For>
              </div>
              {/* A view's controls on the tabs' own row. `[&>div]:contents`:
                  each view's controls arrive in a portal's wrapper div, which
                  must not break the row. */}
              <div
                ref={setEndMount}
                class="flex min-w-0 flex-1 items-center justify-end gap-2 [&>div]:contents"
              />
            </div>
            {/* A second row, drawn only when a view fills it. */}
            <div
              ref={setRow2Mount}
              class="flex flex-wrap items-center gap-2 pb-2 empty:hidden [&>div]:contents"
            />
          </div>
        </div>
      </section>
    );
  }

  return (
    // `@container/shell` is what drives the nav's rail-or-sheet switch and the
    // shell's one-or-two-column layout. Everything here sizes off the width the
    // shell actually has, not off the viewport. The container sits on the outer
    // element and is queried by the inner one: an element can't respond to a
    // container it declares itself.
    <div ref={shellEl} class="@container/shell">
      {/* The gap opens up as the shell widens — at 1600px a rail 32px from a
          1300px panel reads as one crowded block; the extra air is what makes
          the two halves legible as separate things. */}
      <div class="flex flex-col gap-5 @2xl/shell:flex-row @2xl/shell:gap-8 @5xl/shell:gap-10">
        <ModuleSidebar
          active={module()}
          weddingId={props.weddingId}
          weddingSlug={props.weddingSlug}
          tier={props.tier}
          canManage={props.canManage}
          onSelect={props.onModule}
        />

        <div ref={panelEl} class="@container/panel relative min-w-0 flex-1">
          {/* The panel names itself. With the per-wedding header gone from the
              chrome, this is the only thing that says which module is open —
              and unlike a chrome band it scrolls away with the content it
              titles. The hint under it is the same sentence the rail and the
              palette use, so a module reads the same wherever it is met. */}
          <header class="mb-4 flex flex-col gap-4">
            <div class="flex min-w-0 flex-col gap-1">
              <h2
                ref={heading}
                tabindex="-1"
                class="font-display text-text text-ui-lg leading-ui-none font-light"
              >
                {moduleDef(module()).label}
              </h2>
              <p class="font-body text-text-muted text-ui-sm">{moduleDef(module()).hint}</p>
            </div>

            <hr class="gilt-rule opacity-60" />
          </header>

          <div
            ref={sentinel}
            aria-hidden="true"
            class="pointer-events-none invisible absolute h-(--chrome-h) w-px"
          />

          {/* The view bar, only for modules that have more than one visible
              view. It sticks under the top bar; the title above scrolls away. */}
          <Show when={subTabs().length > 1}>
            <ShellBar />
          </Show>

          {/* One panel for the whole module: the sub-tabs swap what is inside
              it, so the tab contract points at this element. It only claims the
              role when there are tabs to label it. */}
          <ViewBarContext.Provider value={viewBar}>
            <div
              ref={(el) => {
                frameEl = el;
                panelSize.frame(el);
              }}
              id={panelId(module())}
              role={subTabs().length > 1 ? "tabpanel" : undefined}
              aria-labelledby={subTabs().length > 1 ? tabId(module(), active()) : undefined}
              tabindex={subTabs().length > 1 ? 0 : undefined}
              class="outline-none"
              style={{ "min-height": holding() ? "100svh" : undefined }}
            >
              {/* The measured box has to be a child of the frame, and `flow-root`
                is what makes the measurement honest: without it a first or last
                child's margin collapses through the wrapper, so the height read
                differs depending on whether the frame is currently clipped. */}
              <div ref={panelSize.content} class="flow-root">
                {/* ── Overview ─────────────────────────────────────────────────── */}
                <Show when={module() === "overview"}>
                  <Overview
                    weddingId={props.weddingId}
                    tier={props.tier}
                    onNavigate={props.onModule}
                  />
                </Show>

                {/* ── Events: List (read) + Edit ───────────────────────────────── */}
                <Show when={module() === "events"}>
                  <Show when={active() === "list"}>
                    <EventTable
                      weddingId={props.weddingId}
                      weddingSlug={props.weddingSlug}
                      canManage={props.canManage}
                    />
                  </Show>
                  {/* Edit = the on-page editor OR an events CSV import, behind one
              choice. A pure write surface, editor-gated (the API also gates
              changes/* with weddingEditor()). */}
                  <Show when={active() === "edit" && props.canEdit}>
                    <EditWorkspace
                      weddingId={props.weddingId}
                      kind="events"
                      canManage={props.canManage}
                      editor={() => (
                        <Suspense fallback={<PanelLoading />}>
                          <EventsEditor weddingId={props.weddingId} />
                        </Suspense>
                      )}
                    />
                  </Show>
                </Show>

                {/* ── Checklist: freeform tasks by lead-time bucket ────────────── */}
                <Show when={module() === "checklist"}>
                  <ChecklistView
                    weddingId={props.weddingId}
                    canEdit={props.canEdit}
                    canManage={props.canManage}
                  />
                </Show>

                {/* ── Run sheet: the day, read-only for every role ─────────────── */}
                <Show when={module() === "run-sheet"}>
                  <Suspense fallback={<PanelLoading />}>
                    <RunSheetView
                      weddingId={props.weddingId}
                      tier={props.tier}
                      callerRole={props.callerRole}
                      canEdit={props.canEdit}
                      onOpenChecklist={
                        props.canEdit ? () => props.onModule("checklist") : undefined
                      }
                    />
                  </Suspense>
                </Show>

                {/* ── Budget: per-category items + payments ────────────────────── */}
                <Show when={module() === "budget"}>
                  <BudgetView
                    weddingId={props.weddingId}
                    canEdit={props.canEdit}
                    canManage={props.canManage}
                  />
                </Show>

                {/* ── Vendors: CRM ("My vendors") + directory Browse ──────────── */}
                <Show when={module() === "vendors"}>
                  {/* One boundary for all three subs, as the registry does: a sub
                switch inside the module never re-suspends once its own chunk
                has landed. */}
                  <Suspense fallback={<PanelLoading />}>
                    <Show when={active() === "index"}>
                      <VendorsView
                        weddingId={props.weddingId}
                        currency={peekCachedBudget(props.weddingId)?.currency ?? "AUD"}
                        canEdit={props.canEdit}
                        canManage={props.canManage}
                      />
                    </Show>
                    <Show when={active() === "browse"}>
                      <DirectoryBrowseView weddingId={props.weddingId} canEdit={props.canEdit} />
                    </Show>
                    <Show when={active() === "enquiries"}>
                      <EnquiriesView
                        weddingId={props.weddingId}
                        currency={peekCachedBudget(props.weddingId)?.currency ?? "AUD"}
                        canEdit={props.canEdit}
                      />
                    </Show>
                  </Suspense>
                </Show>

                {/* ── Registry: the gift list, the gifts received, settings ────── */}
                <Show when={module() === "registry"}>
                  {/* One boundary for all three subs. The list and the gifts
                received share a chunk, so switching between those never
                re-suspends once it has landed; settings is a second chunk and
                suspends the first time it is opened cold — which is what
                `warmPanel` on the sub-tab is for, and why the fallback below
                is the panel-shaped one rather than a spinner. */}
                  <Suspense fallback={<PanelLoading />}>
                    <Show when={active() === "list"}>
                      <RegistryView
                        weddingId={props.weddingId}
                        weddingSlug={props.weddingSlug}
                        view="list"
                        canEdit={props.canEdit}
                      />
                    </Show>
                    <Show when={active() === "gifts"}>
                      <RegistryView
                        weddingId={props.weddingId}
                        weddingSlug={props.weddingSlug}
                        view="gifts"
                        canEdit={props.canEdit}
                        canManage={props.canManage}
                      />
                    </Show>
                    <Show when={active() === "settings"}>
                      <RegistrySettingsView
                        weddingId={props.weddingId}
                        canEdit={props.canEdit}
                        canManage={props.canManage}
                      />
                    </Show>
                  </Suspense>
                </Show>

                {/* ── Guests: Households + RSVPs ───────────────────────────────── */}
                <Show when={module() === "guests"}>
                  <Show when={active() === "list"}>
                    <GuestTable
                      weddingId={props.weddingId}
                      canManage={props.canManage}
                      canEdit={props.canEdit}
                      weddingName={props.weddingName}
                      weddingSlug={props.weddingSlug}
                      inviteMessageLinks={inviteMessageLinks("households")}
                    />
                  </Show>
                  {/* Edit = the on-page editor OR a guests CSV import, behind one
              choice. A pure write surface, editor-gated (the API also gates
              changes/* with weddingEditor()) — the import moved off the read
              tab, where it sat above the list carrying BOTH sheets. */}
                  <Show when={active() === "edit" && props.canEdit}>
                    <EditWorkspace
                      weddingId={props.weddingId}
                      kind="guests"
                      canManage={props.canManage}
                      editor={() => (
                        <Suspense fallback={<PanelLoading />}>
                          <GuestsEditor weddingId={props.weddingId} />
                        </Suspense>
                      )}
                    />
                  </Show>
                  <Show when={active() === "rsvps"}>
                    <RsvpView
                      weddingId={props.weddingId}
                      canEdit={props.canEdit}
                      canManage={props.canManage}
                      weddingSlug={props.weddingSlug}
                      event={props.rsvpEvent}
                      onEvent={props.onRsvpEvent}
                    />
                  </Show>
                </Show>

                {/* ── Seating: tables and who sits where, per event ────────────── */}
                <Show when={module() === "seating"}>
                  <Suspense fallback={<PanelLoading />}>
                    <SeatingView
                      weddingId={props.weddingId}
                      weddingSlug={props.weddingSlug}
                      canEdit={props.canEdit}
                      canManage={props.canManage}
                    />
                  </Suspense>
                </Show>

                {/* ── Invite: Design + Codes ───────────────────────────────────── */}
                <Show when={module() === "invite"}>
                  <Show when={active() === "design"}>
                    {/* The builder is one big write surface; a viewer sees the invite
                itself via the header's "Preview invite" (member-gated) instead. */}
                    <Show
                      when={props.canEdit}
                      fallback={
                        <p class="border-border bg-surface/30 text-text-muted text-ui-base rounded-sm border p-6">
                          You have view-only access to this wedding. Use “Preview invite” above to
                          see the invitation as guests will — ask an owner for editor access to
                          customise it.
                        </p>
                      }
                    >
                      <Suspense fallback={<PanelLoading />}>
                        <InviteBuilder
                          weddingId={props.weddingId}
                          weddingSlug={props.weddingSlug}
                          weddingName={props.weddingName}
                          canEdit={props.canEdit}
                          entitlements={props.entitlements}
                          initialSection={builderSection()}
                          inviteMessageLinks={inviteMessageLinks("message")}
                        />
                      </Suspense>
                    </Show>
                  </Show>
                  <Show when={active() === "codes" && props.canManage}>
                    <RemintPanel
                      weddingId={props.weddingId}
                      inviteMessageLinks={inviteMessageLinks("codes")}
                    />
                  </Show>
                </Show>

                {/* ── Settings: Profile + Co-hosts ─────────────────────────────── */}
                <Show when={module() === "settings"}>
                  <Show when={active() === "wedding"}>
                    <SettingsPanel
                      weddingId={props.weddingId}
                      canManage={props.canManage}
                      canEditRsvpDeadline={props.canEdit}
                      tier={props.tier}
                      onWeddingUpdated={props.onWeddingUpdated}
                      onWeddingDeleted={props.onWeddingDeleted}
                      onTierRaised={props.onTierRaised}
                    />
                  </Show>
                  <Show when={active() === "hosts"}>
                    {/* The role itself, not the flags: the panel needs what the
                  caller may grant, which only the role says. Adding, changing
                  and removing a seat are all `weddingOwner()`. Every seat may
                  leave; the API refuses the last owner. */}
                    <HostsPanel
                      weddingId={props.weddingId}
                      callerRole={props.callerRole}
                      tier={props.tier}
                      canLeave
                      onLeft={props.onLeftWedding}
                      onOwnRoleChanged={props.onOwnRoleChanged}
                    />
                  </Show>
                </Show>
              </div>
            </div>
          </ViewBarContext.Provider>
        </div>
      </div>
      {/* The one tooltip panel for every icon-only control and explained badge
          in the shell (`ActionTip.tsx`); it portals to <body>. */}
      <TipLayer />
    </div>
  );
}
