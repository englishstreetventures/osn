import { For, Show } from "solid-js";

import { peekCachedBudget } from "../lib/budget-store";
import { defaultSub, isSubOf, type Module } from "../lib/dashboard-route";
import BudgetView from "./BudgetView";
import ChecklistView from "./ChecklistView";
import DirectoryBrowseView from "./DirectoryBrowseView";
import EventsEditor from "./EventsEditor";
import EventTable from "./EventTable";
import GuestsEditor from "./GuestsEditor";
import GuestTable from "./GuestTable";
import HostsPanel from "./HostsPanel";
import ImportPanel from "./ImportPanel";
import InviteBuilder from "./InviteBuilder";
import ModuleSidebar from "./ModuleSidebar";
import Overview from "./Overview";
import RemintPanel from "./RemintPanel";
import RsvpView from "./RsvpView";
import SettingsPanel from "./SettingsPanel";
import UpsellPanel from "./UpsellPanel";
import VendorsView from "./VendorsView";

interface ModuleShellProps {
  weddingId: string;
  weddingName: string;
  weddingSlug: string;
  /** Owner of this wedding? Owners get the destructive/owner-only sub-views
   *  (invite/codes, settings save, host management). */
  canManage: boolean;
  /** Owner or editor co-host? Editors get the module write surfaces (invite
   *  design, import, events/guests editors); a viewer co-host is read-only. */
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
   *  Used to gate locked modules — when a module's key is absent the shell
   *  renders an UpsellPanel instead of the feature UI. */
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

const MODULE_SUB_TABS: Partial<Record<Module, SubDef[]>> = {
  schedule: [
    { id: "list", label: "Events" },
    { id: "edit", label: "Edit", edit: true },
  ],
  vendors: [
    { id: "index", label: "My vendors" },
    { id: "browse", label: "Browse" },
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

/**
 * The per-wedding module shell — the IA replacement for the flat DashboardTabs.
 * A left module rail (Overview / Schedule / Guests / Invite / Settings) plus,
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
  // The visible sub-tabs for the current module, filtered by role. Overview and
  // Schedule have no sub-tabs (single view), so they return [].
  const subTabs = (): SubDef[] => {
    const defs = MODULE_SUB_TABS[props.module] ?? [];
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
    if (visible.length === 0) return defaultSub(props.module);
    // A sub the caller isn't allowed to see (viewer on invite/design, co-host on
    // invite/codes) → first visible tab.
    const allowed = visible.some((s) => s.id === sub);
    if (allowed) return sub;
    if (isSubOf(props.module, sub) && !allowed) return visible[0]!.id;
    // Unknown sub entirely.
    return visible[0]!.id;
  };

  const active = () => resolveSub();

  return (
    <div class="flex flex-col gap-6 md:flex-row md:gap-8">
      <ModuleSidebar active={props.module} onSelect={props.onModule} />

      <div class="min-w-0 flex-1">
        {/* Sub-tabs, only for modules that have more than one visible view. */}
        <Show when={subTabs().length > 1}>
          <div class="border-border mb-6 flex flex-wrap gap-1 border-b" role="tablist">
            <For each={subTabs()}>
              {(subTab) => (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active() === subTab.id}
                  onClick={() => props.onSub(subTab.id)}
                  class={`font-body relative -mb-px flex items-center gap-2 px-4 py-2 text-[0.78rem] tracking-[0.1em] uppercase transition ${
                    active() === subTab.id
                      ? "border-gold text-gold border-b-2"
                      : "text-text-muted hover:text-text border-b-2 border-transparent"
                  }`}
                >
                  {subTab.label}
                </button>
              )}
            </For>
          </div>
        </Show>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        <Show when={props.module === "overview"}>
          <Overview
            weddingId={props.weddingId}
            onNavigate={(module, sub) => {
              props.onModule(module);
              if (sub) props.onSub(sub);
            }}
          />
        </Show>

        {/* ── Schedule: Events (read) + Edit ───────────────────────────── */}
        <Show when={props.module === "schedule"}>
          <Show when={active() === "list"}>
            <EventTable weddingId={props.weddingId} weddingSlug={props.weddingSlug} />
          </Show>
          {/* Interactive events editor (E6) — a pure write surface, editor-gated
              (the API also gates changes/* with weddingEditor()). */}
          <Show when={active() === "edit" && props.canEdit}>
            <EventsEditor weddingId={props.weddingId} />
          </Show>
        </Show>

        {/* ── Checklist: freeform tasks by lead-time bucket ────────────── */}
        <Show when={props.module === "checklist"}>
          <ChecklistView weddingId={props.weddingId} canEdit={props.canEdit} />
        </Show>

        {/* ── Budget: per-category items + payments ────────────────────── */}
        <Show when={props.module === "budget"}>
          <BudgetView
            weddingId={props.weddingId}
            canEdit={props.canEdit}
            canManage={props.canManage}
          />
        </Show>

        {/* ── Vendors: CRM ("My vendors") + directory Browse ──────────── */}
        <Show when={props.module === "vendors"}>
          <Show
            when={props.entitlements.includes("vendors")}
            fallback={<UpsellPanel feature="vendors" />}
          >
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
          </Show>
        </Show>

        {/* ── Guests: Households + RSVPs ───────────────────────────────── */}
        <Show when={props.module === "guests"}>
          <Show when={active() === "list"}>
            <div class="flex flex-col gap-8">
              {/* Import is a WRITE surface (weddingEditor()-gated) — viewers
                  don't see it. It rehomes here with the guest list it feeds. */}
              <Show when={props.canEdit}>
                <ImportPanel weddingId={props.weddingId} />
              </Show>
              <GuestTable
                weddingId={props.weddingId}
                canManage={props.canManage}
                weddingName={props.weddingName}
                weddingSlug={props.weddingSlug}
              />
            </div>
          </Show>
          {/* Interactive editor (E5) — a pure write surface, editor-gated (the
              API also gates changes/* with weddingEditor()). */}
          <Show when={active() === "edit" && props.canEdit}>
            <GuestsEditor weddingId={props.weddingId} />
          </Show>
          <Show when={active() === "rsvps"}>
            <RsvpView weddingId={props.weddingId} canEdit={props.canEdit} />
          </Show>
        </Show>

        {/* ── Invite: Design + Codes ───────────────────────────────────── */}
        <Show when={props.module === "invite"}>
          <Show when={active() === "design"}>
            {/* The builder is one big write surface; a viewer sees the invite
                itself via the header's "Preview invite" (member-gated) instead. */}
            <Show
              when={props.canEdit}
              fallback={
                <p class="border-border bg-surface/30 text-text-muted rounded-sm border p-6 text-[0.88rem]">
                  You have view-only access to this wedding. Use “Preview invite” above to see the
                  invitation as guests will — ask the owner for editor access to customise it.
                </p>
              }
            >
              <InviteBuilder weddingId={props.weddingId} />
            </Show>
          </Show>
          <Show when={active() === "codes" && props.canManage}>
            <RemintPanel weddingId={props.weddingId} />
          </Show>
        </Show>

        {/* ── Settings: Profile + Co-hosts ─────────────────────────────── */}
        <Show when={props.module === "settings"}>
          <Show when={active() === "wedding"}>
            <SettingsPanel
              weddingId={props.weddingId}
              canManage={props.canManage}
              onWeddingUpdated={props.onWeddingUpdated}
            />
          </Show>
          <Show when={active() === "hosts"}>
            <HostsPanel weddingId={props.weddingId} canManage={props.canManage} />
          </Show>
        </Show>
      </div>
    </div>
  );
}
