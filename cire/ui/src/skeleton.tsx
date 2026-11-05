import { PULSE } from "./lib/pulse";

/**
 * "Something goes here." The pulsing block a list or a panel shows in place of
 * each row, card or control while it loads, so the page holds its shape and
 * nothing jumps when the content lands.
 *
 * Each shape takes the corner of what it stands in for, and the fill the owner
 * chose for it (englishstreetventures/osn#1837): the blocks at the full
 * surface, the toolbar pieces at 60%, and no edge on any of them.
 *
 * - `card` — a card or a list card: 16px (`lg`), the full surface. The default.
 * - `row` — a table's rows: 6px (`sm`), the corner of `Table`'s frame.
 * - `field` — a filter or search field: 14px (`field`), 60%.
 * - `pill` — a chip strip or a tab track: a pill, 60%.
 *
 * It has no words and stands for nothing a screen reader should read, so it is
 * `aria-hidden` and takes no role. The region that holds both the skeletons
 * and the content that replaces them carries `aria-busy` while it loads.
 *
 * The caller's `class` comes last and carries only the size and the place —
 * `h-*`, `w-*`, `max-w-*`, `min-w-0`, a margin. No other prop reaches the
 * block, so no role, handler or title can.
 */

export type SkeletonStandIn = "card" | "row" | "field" | "pill";

const LOOK = {
  card: "base:bg-ui-surface base:rounded-ui-lg",
  row: "base:bg-ui-surface base:rounded-ui-sm",
  field: "base:bg-ui-surface/60 base:rounded-ui-field",
  pill: "base:bg-ui-surface/60 base:rounded-ui-pill",
} as const satisfies Readonly<Record<SkeletonStandIn, string>>;

/**
 * The classes for `standsFor`, and a card's for anything it does not stand in
 * for: a value cast to `SkeletonStandIn` from stored data must not paint a
 * block with no corner and no fill. `Object.hasOwn`, so `constructor` is not
 * one.
 */
function standInClass(standsFor: SkeletonStandIn | undefined): string {
  // `String`, so a missing value is the key "undefined", which no look has.
  return Object.hasOwn(LOOK, String(standsFor)) ? LOOK[standsFor as SkeletonStandIn] : LOOK.card;
}

export interface SkeletonProps {
  /** What the block stands in for. `card` when left out. */
  standsFor?: SkeletonStandIn;
  /** The block's size and place: height, width, margin. */
  class?: string;
}

export default function Skeleton(props: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      class={`${PULSE} ${standInClass(props.standsFor)}${props.class ? ` ${props.class}` : ""}`}
    />
  );
}
