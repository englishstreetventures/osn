import { createSignal, Show } from "solid-js";
import GuestTable from "./GuestTable";
import EventTable from "./EventTable";

type Tab = "guests" | "events";

interface DashboardTabsProps {
  apiUrl: string;
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
      <nav class="flex gap-1 border-b border-border" role="tablist">
        {TABS.map((tab) => (
          <button
            type="button"
            role="tab"
            aria-selected={active() === tab.id}
            onClick={() => select(tab.id)}
            class={`relative -mb-px px-4 py-2 font-body text-[0.82rem] uppercase tracking-[0.1em] transition ${
              active() === tab.id
                ? "border-b-2 border-gold text-gold"
                : "border-b-2 border-transparent text-text-muted hover:text-text"
            }`}
          >
            {tab.label}
          </button>
        ))}
      </nav>

      <Show when={active() === "guests"}>
        <GuestTable apiUrl={props.apiUrl} />
      </Show>
      <Show when={active() === "events"}>
        <EventTable apiUrl={props.apiUrl} />
      </Show>
    </div>
  );
}
