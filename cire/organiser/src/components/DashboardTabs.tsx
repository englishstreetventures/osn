import { createSignal, For, Show } from "solid-js";

import EventTable from "./EventTable";
import GuestTable from "./GuestTable";
import HostsPanel from "./HostsPanel";
import InviteBuilder from "./InviteBuilder";
import RemintPanel from "./RemintPanel";

type Tab = "guests" | "events" | "invite" | "codes" | "hosts";

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
}

const BASE_TABS: { id: Tab; label: string }[] = [
  { id: "guests", label: "Guests" },
  { id: "events", label: "Events" },
  { id: "invite", label: "Invite" },
];

// `Codes` (the destructive re-mint) is owner-only; `Hosts` stays visible to
// co-hosts (read-only — the panel itself gates the add/remove actions).
const OWNER_TABS: { id: Tab; label: string }[] = [{ id: "codes", label: "Codes" }];
const HOSTS_TAB: { id: Tab; label: string } = { id: "hosts", label: "Hosts" };

function isTab(value: string): value is Tab {
  return (
    value === "guests" ||
    value === "events" ||
    value === "invite" ||
    value === "codes" ||
    value === "hosts"
  );
}

function initialTab(canManage: boolean): Tab {
  if (typeof window === "undefined") return "guests";
  const hash = window.location.hash.replace("#", "");
  if (!isTab(hash)) return "guests";
  // The owner-only Codes tab isn't selectable for co-hosts even via a stale hash.
  if (!canManage && hash === "codes") return "guests";
  return hash;
}

export default function DashboardTabs(props: DashboardTabsProps) {
  const [active, setActive] = createSignal<Tab>(initialTab(props.canManage));

  const tabs = () =>
    props.canManage ? [...BASE_TABS, ...OWNER_TABS, HOSTS_TAB] : [...BASE_TABS, HOSTS_TAB];

  function select(tab: Tab) {
    setActive(tab);
    if (typeof window !== "undefined") {
      history.replaceState(null, "", `#${tab}`);
    }
  }

  return (
    <div class="flex flex-col gap-6">
      <nav class="border-border flex gap-1 border-b" role="tablist">
        <For each={tabs()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={active() === tab.id}
              onClick={() => select(tab.id)}
              class={`font-body relative -mb-px px-4 py-2 text-[0.82rem] tracking-[0.1em] uppercase transition ${
                active() === tab.id
                  ? "border-gold text-gold border-b-2"
                  : "text-text-muted hover:text-text border-b-2 border-transparent"
              }`}
            >
              {tab.label}
            </button>
          )}
        </For>
      </nav>

      <Show when={active() === "guests"}>
        <GuestTable
          weddingId={props.weddingId}
          weddingName={props.weddingName}
          weddingSlug={props.weddingSlug}
        />
      </Show>
      <Show when={active() === "events"}>
        <EventTable weddingId={props.weddingId} />
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
    </div>
  );
}
