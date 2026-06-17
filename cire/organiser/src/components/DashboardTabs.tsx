import { createSignal, Show } from "solid-js";

import EventTable from "./EventTable";
import GuestTable from "./GuestTable";
import HostsPanel from "./HostsPanel";
import InviteBuilder from "./InviteBuilder";

type Tab = "guests" | "events" | "invite" | "hosts";

interface DashboardTabsProps {
  weddingId: string;
  /** Owner of this wedding? Owners can manage co-hosts; co-hosts see the list
   *  read-only. Threaded into the Hosts tab. */
  canManage: boolean;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "guests", label: "Guests" },
  { id: "events", label: "Events" },
  { id: "invite", label: "Invite" },
  { id: "hosts", label: "Hosts" },
];

function initialTab(): Tab {
  if (typeof window === "undefined") return "guests";
  const hash = window.location.hash.replace("#", "");
  if (hash === "events") return "events";
  if (hash === "invite") return "invite";
  if (hash === "hosts") return "hosts";
  return "guests";
}

export default function DashboardTabs(props: DashboardTabsProps) {
  const [active, setActive] = createSignal<Tab>(initialTab());

  function select(tab: Tab) {
    setActive(tab);
    if (typeof window !== "undefined") {
      history.replaceState(null, "", `#${tab}`);
    }
  }

  return (
    <div class="flex flex-col gap-6">
      <nav class="border-border flex gap-1 border-b" role="tablist">
        {TABS.map((tab) => (
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
        ))}
      </nav>

      <Show when={active() === "guests"}>
        <GuestTable weddingId={props.weddingId} />
      </Show>
      <Show when={active() === "events"}>
        <EventTable weddingId={props.weddingId} />
      </Show>
      <Show when={active() === "invite"}>
        <InviteBuilder weddingId={props.weddingId} />
      </Show>
      <Show when={active() === "hosts"}>
        <HostsPanel weddingId={props.weddingId} canManage={props.canManage} />
      </Show>
    </div>
  );
}
