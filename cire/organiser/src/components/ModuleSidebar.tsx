import { For } from "solid-js";

import type { Module } from "../lib/dashboard-route";

/** A module's nav entry. `glyph` is a small leading mark that makes the row
 *  scannable; `hint` is its native-tooltip one-liner. */
interface ModuleDef {
  id: Module;
  label: string;
  glyph: string;
  hint: string;
}

/** The module nav, in workflow order: land on Overview, then build the day
 *  (Schedule) → invite the people (Guests) → dress it up (Invite) → housekeeping
 *  (Settings). Every module has a read view, so the whole nav is visible to
 *  viewers; write-only surfaces are gated inside each module, not hidden here. */
const MODULE_NAV: ModuleDef[] = [
  { id: "overview", label: "Overview", glyph: "◈", hint: "Your wedding at a glance" },
  { id: "schedule", label: "Schedule", glyph: "◇", hint: "Your ceremony, reception, and more" },
  { id: "checklist", label: "Checklist", glyph: "✓", hint: "Your planning tasks by lead time" },
  { id: "budget", label: "Budget", glyph: "$", hint: "Estimates, quotes, and payments" },
  { id: "guests", label: "Guests", glyph: "✎", hint: "Households, invites, and RSVPs" },
  { id: "invite", label: "Invite", glyph: "✦", hint: "Photos, story, colours, and codes" },
  { id: "settings", label: "Settings", glyph: "✧", hint: "Profile, budget, and co-hosts" },
];

/**
 * The dashboard's left module nav — the IA shell's primary navigation. On wide
 * screens it's a vertical rail; on narrow screens it collapses to a horizontal
 * scrolling strip above the panel. Fully keyboard-accessible: it's a real
 * `<nav>` of buttons with `aria-current` on the active module, so tab/enter
 * work and screen readers announce the current section.
 */
export default function ModuleSidebar(props: {
  active: Module;
  onSelect: (module: Module) => void;
}) {
  return (
    <nav
      aria-label="Wedding modules"
      class="border-border flex gap-1 overflow-x-auto border-b pb-2 md:w-48 md:shrink-0 md:flex-col md:gap-0.5 md:overflow-visible md:border-b-0 md:pb-0"
    >
      <For each={MODULE_NAV}>
        {(mod) => {
          const isActive = () => props.active === mod.id;
          return (
            <button
              type="button"
              aria-current={isActive() ? "page" : undefined}
              title={mod.hint}
              onClick={() => props.onSelect(mod.id)}
              class={`font-body flex shrink-0 items-center gap-2.5 rounded-sm px-3 py-2 text-left text-[0.82rem] tracking-[0.08em] uppercase transition-colors md:w-full ${
                isActive()
                  ? "bg-gold/10 text-gold border-gold border-l-2 md:pl-[calc(0.75rem-2px)]"
                  : "text-text-muted hover:text-text hover:bg-surface/40 border-l-2 border-transparent md:pl-[calc(0.75rem-2px)]"
              }`}
            >
              <span aria-hidden class="text-[0.95em] opacity-80">
                {mod.glyph}
              </span>
              {mod.label}
            </button>
          );
        }}
      </For>
    </nav>
  );
}
