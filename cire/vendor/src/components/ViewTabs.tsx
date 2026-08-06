import { For } from "solid-js";

import { createSlidingPill } from "../lib/sliding-pill";

/**
 * The portal's two views, as one control.
 *
 * Before this they were two bare `<button>`s that turned gold when active,
 * sitting in a row beside "Sign out" — so "which view am I in" and "leave" were
 * the same kind of thing in the same place, told apart only by a colour. A
 * bordered strip with a single travelling highlight says the two are a choice
 * between each other, and the account action moved into the profile menu.
 *
 * The highlight is one box that moves, not one per tab. Done per-tab it blinks
 * between positions and the label beside it jumps by the border's width; done as
 * a single absolutely positioned box it slides, and the labels never move at
 * all. `createSlidingPill` owns that; the two rules it cannot enforce are met
 * here — the track is `relative`, and the pill is `absolute` with no `inset`.
 *
 * The pill sits *under* the labels in source order, and the track is a
 * containing block, so the labels paint above it. An absolutely positioned
 * element paints above non-positioned siblings in the same stacking context,
 * which is how this ends up covering its own text if the track forgets
 * `relative`.
 */

export type VendorView = "listings" | "enquiries";

const TABS: ReadonlyArray<{ value: VendorView; label: string }> = [
  { value: "listings", label: "Listings" },
  { value: "enquiries", label: "Enquiries" },
];

export default function ViewTabs(props: {
  value: VendorView;
  onChange: (next: VendorView) => void;
}) {
  const pill = createSlidingPill(() => props.value);

  return (
    // `tablist` is deliberately *not* used: these tabs swap the whole page and
    // push history, and the ARIA tab pattern promises a panel that is a sibling
    // of the strip plus arrow-key roving focus over it. What this actually is,
    // is two links-shaped-as-buttons — so it is announced as what it is, with
    // `aria-current` naming the one you are on.
    <div
      ref={pill.track}
      class="border-border bg-surface/40 rounded-pill relative flex shrink-0 items-center gap-0.5 border p-0.5"
    >
      <span
        aria-hidden="true"
        class="bg-brand rounded-pill pointer-events-none absolute top-0 left-0"
        style={pill.style()}
      />
      <For each={TABS}>
        {(tab) => (
          <button
            ref={pill.item(tab.value)}
            type="button"
            aria-current={props.value === tab.value ? "page" : undefined}
            onClick={() => props.onChange(tab.value)}
            class={`font-body rounded-pill relative px-3 py-1.5 text-[0.7rem] tracking-[0.12em] uppercase transition-colors duration-(--dur-fast) ease-(--ease-out) @2xl/frame:px-4 ${
              props.value === tab.value ? "text-on-brand" : "text-text-muted hover:text-text"
            }`}
          >
            {tab.label}
          </button>
        )}
      </For>
    </div>
  );
}
