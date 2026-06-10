import { createSignal, Show } from "solid-js";

import EventTable from "./EventTable";
import GuestTable from "./GuestTable";

type Tab = "guests" | "events";

interface DashboardTabsProps {
  weddingId: string;
}

const TABS: { id: Tab; label: string }[] = [
  { id: "guests", label: "Guests" },
  { id: "events", label: "Events" },
];

function initialTab(): Tab {
  if (typeof window === "undefined") return "guests";
  const hash = window.location.hash.replace("#", "");
  return hash === "events" ? "events" : "guests";
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
    </div>
  );
}
