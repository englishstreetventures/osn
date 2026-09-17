import { type Component, createMemo, For, lazy, Show, Suspense } from "solid-js";

import { createAutoSize } from "../lib/auto-size";
import { peekCachedBudget } from "../lib/budget-store";
import { DEFAULT_MODULE, defaultSub, isSubOf, type Module } from "../lib/dashboard-route";
import { isModuleLocked, moduleDef } from "../lib/module-nav";
import { createSlidingPill } from "../lib/sliding-pill";
import BudgetView from "./BudgetView";
import ChecklistView from "./ChecklistView";
import EditWorkspace from "./EditWorkspace";
import EventTable from "./EventTable";
import GuestTable from "./GuestTable";
import HostsPanel from "./HostsPanel";
import ModuleSidebar from "./ModuleSidebar";
import Overview from "./Overview";
import PanelLoading from "./PanelLoading";
import RemintPanel from "./RemintPanel";
import RsvpView from "./RsvpView";
import SettingsPanel from "./SettingsPanel";

/**
 * The three big write surfaces, split out of the first load.
 *
 * The portal is one `client:only` island, so everything a module might show
 * used to arrive before the Overview could paint — including the invite builder
 * (its own tree plus every design in `@cire/invite-designs`) and the events
 * editor (which drags in `@shared/sortable`). None of the three is on the path to the
 * page an organiser actually lands on, and two of them are closed to a viewer
 * entirely. They now arrive when the sub-tab that shows them is chosen.
 *
 * The rest stay eager on purpose: they are the read views, they are small, and
 * a rail click that pauses is a worse trade than the bytes.
 */
const loadEventsEditor = () => import("./EventsEditor");
const loadGuestsEditor = () => import("./GuestsEditor");
const loadInviteBuilder = () => import("./InviteBuilder");

/**
 * The two entitlement-gated modules, split out for a different reason than the
 * three above.
 *
 * They are read views, so by the rule above they would stay eager. They don't,
 * because the shell now coerces a locked module to Overview: an organiser
 * without the key does not merely see an upsell in the module's place, they
 * cannot reach the module at all. Eager-loading the registry's tree and money
 * formatting, or the vendors module's three panels and its enquiry dialogs, for
 * an organiser who provably cannot open either is paying for a view that will
 * not be shown. Where the key is held the cost lands on the rail click that
 * opens the module, warmed by the hover on the sub-tab through `PANEL_LOADERS`
 * below.
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

const EventsEditor = lazy(loadEventsEditor);
const GuestsEditor = lazy(loadGuestsEditor);
const InviteBuilder = lazy(loadInviteBuilder);
const RegistryView = lazy(loadRegistry);
const RegistrySettingsView = lazy(loadRegistrySettings);
const VendorsView = lazy(loadVendors);
const DirectoryBrowseView = lazy(loadDirectoryBrowse);
const EnquiriesView = lazy(loadEnquiries);

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
 * rather than going quiet (T-U2 / P-I3). The lookup below is `?.()` over a
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
  /** Owner of this wedding? Owners get the destructive/owner-only sub-views
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
  /** Report a module switch up so the parent updates the hash (resets to the
   *  module's default sub). */
  onModule: (module: Module) => void;
  /** Report a sub-view switch up so the parent updates the hash. */
  onSub: (sub: string) => void;
  onWeddingUpdated?: (patch: { displayName: string; slug: string }) => void;
  /** Entitlement keys active on this wedding (from the API list response).
   *  A module whose key is absent is locked: its nav row fades and offers the
   *  upgrade, and the module itself never renders — the shell coerces it to
   *  Overview. */
  entitlements: string[];
  /** Effective guest ceiling derived from the entitlement set. Surfaced for
   *  informational display (e.g. Overview) — enforcement is server-side. */
  guestCap: number;
}

/** A sub-tab within a module. `manage`/`edit` mark role-gated subs so a viewer
 *  or non-owner never sees (or reaches, via a stale deep link) a write-only
 *  view. */
interface SubDef {
  id: string;
  label: string;
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
    { id: "list", label: "List" },
    { id: "edit", label: "Edit", edit: true },
  ],
  vendors: [
    { id: "index", label: "My vendors" },
    { id: "browse", label: "Browse" },
    { id: "enquiries", label: "Enquiries" },
  ],
  registry: [
    { id: "list", label: "Gift list" },
    { id: "gifts", label: "Gifts received" },
    // `edit`, not `manage`: a co-host with edit rights may publish the list and
    // write its copy. The one owner-only control — connecting the account gifts
    // are paid into — is disabled inside the panel with the reason, rather than
    // hiding a whole tab from someone who is allowed most of it.
    { id: "settings", label: "Settings", edit: true },
  ],
  guests: [
    { id: "list", label: "Households" },
    { id: "edit", label: "Edit", edit: true },
    { id: "rsvps", label: "RSVPs" },
  ],
  invite: [
    { id: "design", label: "Design", edit: true },
    { id: "codes", label: "Codes", manage: true },
  ],
  settings: [
    { id: "wedding", label: "Profile" },
    { id: "hosts", label: "Co-hosts" },
  ],
};

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
    isModuleLocked(props.module, props.entitlements) ? DEFAULT_MODULE : props.module,
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

  // Roving tabindex: only the selected tab is in the tab order, and the arrow
  // keys move focus between the rest. Refs are indexed by position in the
  // current module's visible tabs — a module switch rewrites every entry the
  // handler can reach, so a stale ref past the new length is never read.
  const tabRefs: HTMLButtonElement[] = [];

  // The strip's selected background, as one box that travels rather than one
  // per tab that switches on and off. The strip wraps at narrow panel widths,
  // which is why the pill measures both axes.
  const pill = createSlidingPill(active);

  // The panel takes the height of whatever view the tabs swapped in, and moves
  // between the two rather than jumping. Nothing is held at rest — see the note
  // in `auto-size.ts` for why that matters on a panel this general.
  const panelSize = createAutoSize();

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

  return (
    // `@container/shell` is what drives the nav's rail-or-sheet switch and the
    // shell's one-or-two-column layout. Everything here sizes off the width the
    // shell actually has, not off the viewport. The container sits on the outer
    // element and is queried by the inner one: an element can't respond to a
    // container it declares itself.
    <div class="@container/shell">
      {/* The gap opens up as the shell widens — at 1600px a rail 32px from a
          1300px panel reads as one crowded block; the extra air is what makes
          the two halves legible as separate things. */}
      <div class="flex flex-col gap-5 @2xl/shell:flex-row @2xl/shell:gap-8 @5xl/shell:gap-10">
        <ModuleSidebar
          active={module()}
          entitlements={props.entitlements}
          onSelect={props.onModule}
        />

        <div class="@container/panel min-w-0 flex-1">
          {/* The panel names itself. With the per-wedding header gone from the
              chrome, this is the only thing that says which module is open —
              and unlike a chrome band it scrolls away with the content it
              titles. The hint under it is the same sentence the rail and the
              palette use, so a module reads the same wherever it is met. */}
          <header class="mb-6 flex flex-col gap-4">
            <div class="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
              <div class="flex min-w-0 flex-col gap-1">
                <h2 class="font-display text-text text-ui-lg leading-none font-light">
                  {moduleDef(module()).label}
                </h2>
                <p class="font-body text-text-muted text-ui-sm">{moduleDef(module()).hint}</p>
              </div>

              {/* Sub-tabs, only for modules that have more than one visible
                  view. Manual activation (arrows move focus, Enter/Space
                  selects): every panel behind these mounts a fetching view, so
                  selection-follows-focus would fire a request per keypress. */}
              <Show when={subTabs().length > 1}>
                <div
                  ref={pill.track}
                  class="border-border bg-surface/30 relative inline-flex max-w-full flex-wrap gap-1 rounded-sm border p-1"
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
                      <button
                        ref={(el) => {
                          // Two things want this element: the roving tabindex,
                          // which reaches tabs by position, and the pill, which
                          // reaches them by id. One ref, both told.
                          tabRefs[index()] = el;
                          pill.item(subTab.id)(el);
                        }}
                        type="button"
                        role="tab"
                        id={tabId(module(), subTab.id)}
                        aria-controls={panelId(module())}
                        aria-selected={active() === subTab.id}
                        tabindex={active() === subTab.id ? 0 : -1}
                        onKeyDown={(event) => onTabKeyDown(event, index())}
                        onPointerEnter={() => warmPanel(module(), subTab.id)}
                        onFocus={() => warmPanel(module(), subTab.id)}
                        onClick={() => props.onSub(subTab.id)}
                        class={`font-body text-ui-xs tracking-ui-wider relative flex items-center gap-2 rounded-sm px-3.5 py-1.5 whitespace-nowrap uppercase transition-colors duration-(--dur-fast) ease-(--ease-out) ${
                          active() === subTab.id
                            ? "text-gold"
                            : "text-text-muted hover:text-text hover:bg-surface/60"
                        }`}
                      >
                        {subTab.label}
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>

            <hr class="gilt-rule opacity-60" />
          </header>

          {/* One panel for the whole module: the sub-tabs swap what is inside
              it, so the tab contract points at this element. It only claims the
              role when there are tabs to label it. */}
          <div
            ref={panelSize.frame}
            id={panelId(module())}
            role={subTabs().length > 1 ? "tabpanel" : undefined}
            aria-labelledby={subTabs().length > 1 ? tabId(module(), active()) : undefined}
            tabindex={subTabs().length > 1 ? 0 : undefined}
            class="outline-none"
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
                  entitlements={props.entitlements}
                  onNavigate={(target, sub) => {
                    props.onModule(target);
                    if (sub) props.onSub(sub);
                  }}
                />
              </Show>

              {/* ── Events: List (read) + Edit ───────────────────────────────── */}
              <Show when={module() === "events"}>
                <Show when={active() === "list"}>
                  <EventTable weddingId={props.weddingId} weddingSlug={props.weddingSlug} />
                </Show>
                {/* Edit = the on-page editor OR an events CSV import, behind one
              choice. A pure write surface, editor-gated (the API also gates
              changes/* with weddingEditor()). */}
                <Show when={active() === "edit" && props.canEdit}>
                  <EditWorkspace
                    weddingId={props.weddingId}
                    kind="events"
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
                <ChecklistView weddingId={props.weddingId} canEdit={props.canEdit} />
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
                    weddingName={props.weddingName}
                    weddingSlug={props.weddingSlug}
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
                    editor={() => (
                      <Suspense fallback={<PanelLoading />}>
                        <GuestsEditor weddingId={props.weddingId} />
                      </Suspense>
                    )}
                  />
                </Show>
                <Show when={active() === "rsvps"}>
                  <RsvpView weddingId={props.weddingId} canEdit={props.canEdit} />
                </Show>
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
                        You have view-only access to this wedding. Use “Preview invite” above to see
                        the invitation as guests will — ask the owner for editor access to customise
                        it.
                      </p>
                    }
                  >
                    <Suspense fallback={<PanelLoading />}>
                      <InviteBuilder
                        weddingId={props.weddingId}
                        weddingSlug={props.weddingSlug}
                        entitlements={props.entitlements}
                      />
                    </Suspense>
                  </Show>
                </Show>
                <Show when={active() === "codes" && props.canManage}>
                  <RemintPanel weddingId={props.weddingId} />
                </Show>
              </Show>

              {/* ── Settings: Profile + Co-hosts ─────────────────────────────── */}
              <Show when={module() === "settings"}>
                <Show when={active() === "wedding"}>
                  <SettingsPanel
                    weddingId={props.weddingId}
                    canManage={props.canManage}
                    canEditRsvpDeadline={props.canEdit}
                    onWeddingUpdated={props.onWeddingUpdated}
                  />
                </Show>
                <Show when={active() === "hosts"}>
                  {/* Two flags, because the API has two gates here: adding a
                  co-host is `weddingEditor()` (so `canEdit`), while changing a
                  role or removing one stays `weddingOwner()`. */}
                  <HostsPanel
                    weddingId={props.weddingId}
                    canManage={props.canManage}
                    canAdd={props.canEdit}
                  />
                </Show>
              </Show>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
