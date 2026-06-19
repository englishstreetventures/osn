import { createSignal, For, onCleanup, onMount, Show } from "solid-js";

import EventTable from "./EventTable";
import GuestTable from "./GuestTable";
import HostsPanel from "./HostsPanel";
import InviteBuilder from "./InviteBuilder";
import RemintPanel from "./RemintPanel";

type Tab = "events" | "guests" | "invite" | "codes" | "hosts";

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
  { id: "guests", label: "Guests", glyph: "✎", hint: "Households, invites, and RSVPs" },
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

function isTab(value: string): value is Tab {
  return (
    value === "guests" ||
    value === "events" ||
    value === "invite" ||
    value === "codes" ||
    value === "hosts"
  );
}

function resolveHash(hash: string, canManage: boolean): Tab {
  if (!isTab(hash)) return "events";
  // The owner-only Codes tab isn't selectable for co-hosts even via a stale hash.
  if (!canManage && hash === "codes") return "events";
  return hash;
}

function initialTab(canManage: boolean): Tab {
  if (typeof window === "undefined") return "events";
  return resolveHash(window.location.hash.replace("#", ""), canManage);
}

export default function DashboardTabs(props: DashboardTabsProps) {
  const [active, setActive] = createSignal<Tab>(initialTab(props.canManage));

  // React to external hash changes — the Getting-started checklist jumps tabs by
  // setting the hash, and the browser back/forward buttons move through them too.
  function onHashChange() {
    setActive(resolveHash(window.location.hash.replace("#", ""), props.canManage));
  }
  onMount(() => window.addEventListener("hashchange", onHashChange));
  onCleanup(() => {
    if (typeof window !== "undefined") window.removeEventListener("hashchange", onHashChange);
  });

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
      <nav class="border-border flex flex-wrap gap-1 border-b" role="tablist">
        <For each={tabs()}>
          {(tab) => (
            <button
              type="button"
              role="tab"
              aria-selected={active() === tab.id}
              title={tab.hint}
              onClick={() => select(tab.id)}
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
        <EventTable weddingId={props.weddingId} />
      </Show>
      <Show when={active() === "guests"}>
        <GuestTable
          weddingId={props.weddingId}
          weddingName={props.weddingName}
          weddingSlug={props.weddingSlug}
        />
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
