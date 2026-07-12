import { For, Show } from "solid-js";

import { type DashboardTab, DEFAULT_TAB } from "../lib/dashboard-route";
import EventLocationsPanel from "./EventLocationsPanel";
import EventTable from "./EventTable";
import GuestTable from "./GuestTable";
import HostsPanel from "./HostsPanel";
import InviteBuilder from "./InviteBuilder";
import RemintPanel from "./RemintPanel";
import RsvpView from "./RsvpView";
import SettingsPanel from "./SettingsPanel";

type Tab = DashboardTab;

interface DashboardTabsProps {
  weddingId: string;
  /** Display name of the wedding — passed to the guest list for the copyable
   *  invite message. */
  weddingName: string;
  /** URL slug of the wedding — passed to the guest list so the copyable invite
   *  message links to this wedding's path (`CIRE_WEB_URL/<slug>`). */
  weddingSlug: string;
  /** Owner of this wedding? Owners can manage co-hosts + re-mint codes; co-hosts
   *  see the list read-only and don't get the destructive Codes tab. */
  canManage: boolean;
  /** Active tab — controlled by the parent, which owns the URL hash so a deep
   *  link / hard refresh restores the exact tab. */
  tab: Tab;
  /** Report a tab switch up to the parent so it can update the hash. */
  onTab: (tab: Tab) => void;
  /** Report a saved name/slug (Settings tab) up so the header + wedding list
   *  stay current without a refetch. */
  onWeddingUpdated?: (patch: { displayName: string; slug: string }) => void;
}

/** A tab's nav entry. The glyph is a small leading mark that makes the row
 *  scannable; `hint` is its native-tooltip one-liner. Order follows the real
 *  workflow: build the day (Events) → invite the people (Guests) → dress it up
 *  (Invite) → housekeeping (Codes, Hosts). */
interface TabDef {
  id: Tab;
  label: string;
  glyph: string;
  hint: string;
}

const BASE_TABS: TabDef[] = [
  { id: "events", label: "Events", glyph: "◇", hint: "Your ceremony, reception, and more" },
  { id: "guests", label: "Guests", glyph: "✎", hint: "Households, invites, and codes" },
  { id: "rsvps", label: "RSVPs", glyph: "✓", hint: "Who's coming, per event, with dietary notes" },
  { id: "invite", label: "Invite", glyph: "✦", hint: "Photos, story, colours, and fonts" },
];

// `Codes` (the destructive re-mint) is owner-only; `Hosts` stays visible to
// co-hosts (read-only — the panel itself gates the add/remove actions).
const OWNER_TABS: TabDef[] = [
  { id: "codes", label: "Codes", glyph: "⌗", hint: "Change the guest code style" },
];
const HOSTS_TAB: TabDef = {
  id: "hosts",
  label: "Hosts",
  glyph: "♔",
  hint: "Share editing with a co-host",
};
// `Settings` stays visible to co-hosts (read-only — the panel itself gates the
// form on `canManage`, and the API's save is owner-only).
const SETTINGS_TAB: TabDef = {
  id: "settings",
  label: "Settings",
  glyph: "✧",
  hint: "Date, location, guest count, and budget",
};

/**
 * Resolve the visible tab from the controlled `tab` prop. The owner-only Codes
 * tab isn't selectable for co-hosts even via a deep link / stale hash — it falls
 * back to the default tab so a `#/weddings/<id>/codes` link opens to a visible
 * panel rather than a blank one.
 */
function visibleTab(tab: Tab, canManage: boolean): Tab {
  if (!canManage && tab === "codes") return DEFAULT_TAB;
  return tab;
}

export default function DashboardTabs(props: DashboardTabsProps) {
  const active = () => visibleTab(props.tab, props.canManage);

  const tabs = () =>
    props.canManage
      ? [...BASE_TABS, ...OWNER_TABS, HOSTS_TAB, SETTINGS_TAB]
      : [...BASE_TABS, HOSTS_TAB, SETTINGS_TAB];

  return (
    <div class="flex flex-col gap-6">
      <nav class="border-border flex flex-wrap gap-1 border-b" role="tablist">
        <For each={tabs()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={active() === tab.id}
              title={tab.hint}
              onClick={() => props.onTab(tab.id)}
              class={`font-body relative -mb-px flex items-center gap-2 px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition ${
                active() === tab.id
                  ? "border-gold text-gold border-b-2"
                  : "text-text-muted hover:text-text border-b-2 border-transparent"
              }`}
            >
              <span aria-hidden class="text-[0.9em] opacity-80">
                {tab.glyph}
              </span>
              {tab.label}
            </button>
          )}
        </For>
      </nav>

      <Show when={active() === "events"}>
        <div class="flex flex-col gap-6">
          <EventTable weddingId={props.weddingId} weddingSlug={props.weddingSlug} />
          {/* Per-event planning locations (member-editable, like the import).
              Location is event-scoped — one wedding can celebrate across
              countries — so it lives with the schedule, not in Settings. */}
          <EventLocationsPanel weddingId={props.weddingId} />
        </div>
      </Show>
      <Show when={active() === "guests"}>
        <GuestTable
          weddingId={props.weddingId}
          weddingName={props.weddingName}
          weddingSlug={props.weddingSlug}
        />
      </Show>
      <Show when={active() === "rsvps"}>
        <RsvpView weddingId={props.weddingId} />
      </Show>
      <Show when={active() === "invite"}>
        <InviteBuilder weddingId={props.weddingId} />
      </Show>
      <Show when={props.canManage && active() === "codes"}>
        <RemintPanel weddingId={props.weddingId} />
      </Show>
      <Show when={active() === "hosts"}>
        <HostsPanel weddingId={props.weddingId} canManage={props.canManage} />
      </Show>
      <Show when={active() === "settings"}>
        <SettingsPanel
          weddingId={props.weddingId}
          canManage={props.canManage}
          onWeddingUpdated={props.onWeddingUpdated}
        />
      </Show>
    </div>
  );
}
