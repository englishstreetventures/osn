import { For } from "solid-js";

import { Icon } from "./icons";

const CATEGORIES = [
  { id: "all", label: "For you", ico: "\u2726" },
  { id: "tonight", label: "Tonight", ico: "\u25D0" },
  { id: "free", label: "Free", ico: "\u25CB" },
  { id: "music", label: "Music", ico: "\u266A" },
  { id: "food", label: "Food & Drink", ico: "\u2318" },
  { id: "outdoor", label: "Outdoors", ico: "\u25B3" },
  { id: "art", label: "Art & Design", ico: "\u25A3" },
  { id: "talks", label: "Talks", ico: "\u275D" },
  { id: "sports", label: "Sports", ico: "\u25C7" },
  { id: "late", label: "Late night", ico: "\u263E" },
] as const;

export type CategoryId = (typeof CATEGORIES)[number]["id"];

export function FilterRail(props: { active: string; onSelect: (id: string) => void }) {
  return (
    <div class="filter-rail mb-3.5 flex items-center gap-2 overflow-x-auto pb-1">
      <For each={CATEGORIES}>
        {(cat) => (
          <button
            type="button"
            class={`inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[12.5px] font-medium transition-colors ${
              props.active === cat.id
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-card text-foreground hover:bg-secondary"
            }`}
            onClick={() => props.onSelect(cat.id)}
          >
            <span class="text-[13px]">{cat.ico}</span>
            {cat.label}
          </button>
        )}
      </For>
      <span class="w-2 shrink-0" />
      <button
        type="button"
        class="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border border-border bg-card px-3 text-[12.5px] font-medium text-muted-foreground hover:bg-secondary"
      >
        <Icon name="filter" size={12} />
        More filters
      </button>
    </div>
  );
}
