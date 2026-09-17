import { For } from "solid-js";

import { Icon } from "../components/Icon";
import { FilterChip } from "./FilterChip";

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

export function FilterRail(props: {
  active: string;
  onSelect: (id: string) => void;
  onOpenMoreFilters?: () => void;
  moreFiltersActive?: boolean;
}) {
  return (
    <div class="filter-rail mb-3.5 flex items-center gap-2 overflow-x-auto pb-1">
      <For each={CATEGORIES}>
        {(cat) => (
          <FilterChip pressed={props.active === cat.id} onPress={() => props.onSelect(cat.id)}>
            <span class="text-ui-sm">{cat.ico}</span>
            {cat.label}
          </FilterChip>
        )}
      </For>
      <span class="w-2 shrink-0" />
      <FilterChip
        pressed={props.moreFiltersActive ?? false}
        tone="muted"
        onPress={() => props.onOpenMoreFilters?.()}
      >
        <Icon name="filter" size={12} />
        More filters
      </FilterChip>
    </div>
  );
}
