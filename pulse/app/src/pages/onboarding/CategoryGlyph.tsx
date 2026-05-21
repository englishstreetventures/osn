import { Show } from "solid-js";

import type { InterestCategory } from "../../lib/onboarding";

/**
 * Inline category glyphs used inside the interests-step chip grid.
 *
 * These are rendered with `currentColor` so they pick up the chip's
 * selected/unselected colour from `.onb-chip`'s CSS — no extra props
 * needed. Glyphs intentionally read as editorial Instrument-Serif-style
 * marks rather than UI iconography to match Pulse's `pulse/DESIGN.md`
 * §"Glyph placeholders" pattern.
 *
 * Adding a new category? 1) extend `INTEREST_CATEGORIES` in the service
 * (and reflect it here), 2) update the metric attribute bucketing if the
 * category should affect a metric.
 */

export interface CategoryGlyphProps {
  category: InterestCategory;
  size?: number;
}

export function CategoryGlyph(props: CategoryGlyphProps) {
  const size = () => props.size ?? 28;
  return (
    <svg
      class="onb-chip-glyph"
      width={size()}
      height={size()}
      viewBox="0 0 32 32"
      fill="none"
      stroke="currentColor"
      stroke-width="1.6"
      stroke-linecap="round"
      stroke-linejoin="round"
      aria-hidden="true"
    >
      <Show when={props.category === "music"}>
        <path d="M11 22V8l12-2v14" />
        <circle cx="9" cy="22" r="3" fill="currentColor" />
        <circle cx="21" cy="20" r="3" fill="currentColor" />
      </Show>
      <Show when={props.category === "food"}>
        <path d="M8 8c0 8 0 12 4 12h8c4 0 4-4 4-12" />
        <path d="M10 8h12" />
        <path d="M16 4v4" />
      </Show>
      <Show when={props.category === "sports"}>
        <circle cx="16" cy="16" r="10" />
        <path d="M16 6v20M6 16h20" />
        <path d="M9 9l14 14M23 9L9 23" stroke-opacity="0.45" />
      </Show>
      <Show when={props.category === "arts"}>
        <path d="M6 22l8-16 4 8 4-4 4 12z" />
        <circle cx="11" cy="10" r="1.4" fill="currentColor" stroke="none" />
      </Show>
      <Show when={props.category === "tech"}>
        <rect x="6" y="9" width="20" height="12" rx="1.5" />
        <path d="M11 25h10M14 21v4M18 21v4" />
      </Show>
      <Show when={props.category === "community"}>
        <circle cx="11" cy="13" r="3" />
        <circle cx="21" cy="13" r="3" />
        <path d="M5 24c1.4-3.4 4-5 6-5s4.6 1.6 6 5" />
        <path d="M16 24c1.4-3.4 4-5 6-5s4.6 1.6 5 4" />
      </Show>
      <Show when={props.category === "education"}>
        <path d="M4 12l12-6 12 6-12 6z" />
        <path d="M9 14v6c0 2 4 3 7 3s7-1 7-3v-6" />
      </Show>
      <Show when={props.category === "social"}>
        <path d="M6 22V11a3 3 0 013-3h14a3 3 0 013 3v8a3 3 0 01-3 3h-9l-7 4z" />
      </Show>
      <Show when={props.category === "nightlife"}>
        <path
          d="M22 18a8 8 0 11-9-9 6 6 0 009 9z"
          fill="currentColor"
          stroke="none"
          opacity="0.18"
        />
        <path d="M22 18a8 8 0 11-9-9 6 6 0 009 9z" />
        <path d="M24 7l1 2 2 1-2 1-1 2-1-2-2-1 2-1z" fill="currentColor" stroke="none" />
      </Show>
      <Show when={props.category === "outdoor"}>
        <path d="M4 24l8-14 4 6 3-4 9 12z" />
        <path d="M16 24v-4" stroke-opacity="0.45" />
      </Show>
      <Show when={props.category === "family"}>
        <circle cx="12" cy="11" r="3" />
        <circle cx="22" cy="13" r="2" />
        <path d="M5 24c1.6-3.6 4.2-5 7-5s5.4 1.4 7 5" />
        <path d="M19 24c.7-2.5 2.2-3.5 3.5-3.5s2.8 1 3.5 3.5" />
      </Show>
    </svg>
  );
}

export const CATEGORY_LABELS: Record<InterestCategory, string> = {
  music: "Music",
  food: "Food",
  sports: "Sports",
  arts: "Arts",
  tech: "Tech",
  community: "Community",
  education: "Learning",
  social: "Social",
  nightlife: "Nightlife",
  outdoor: "Outdoor",
  family: "Family",
};
