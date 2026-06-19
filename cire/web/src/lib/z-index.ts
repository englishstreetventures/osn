/**
 * Single source of truth for the guest site's stacking order.
 *
 * Every overlay/floating element in `cire/web` should pull its `z-index` from
 * here rather than hardcoding a `z-<n>` utility at the call site. Centralising
 * the order is what stops a future overlay from silently regressing the layer
 * stack — the failure mode that produced #203, where the Add-to-Calendar
 * popover shipped at `z-90`, *below* the `z-100` modal, and rendered behind the
 * modal backdrop (invisible + unclickable: "Add to Calendar doesn't work").
 *
 * ## The layers (low → high)
 *
 * | Layer           | z   | What sits here                                          |
 * | --------------- | --- | ------------------------------------------------------- |
 * | `BASE`          | 0   | Normal page flow — hero, story, event grid (default).   |
 * | `EVENT_CARD`    | 10  | An event card's own local stacking context.             |
 * | `MODAL`         | 100 | `AnimatedModal` backdrop + panel (details / RSVP).      |
 * | `MODAL_POPOVER` | 110 | Popover launched *from inside* a modal (AddToCalendar). |
 *
 * ## The invariant
 *
 * A popover launched from inside a modal MUST sit ABOVE that modal, i.e.
 * `MODAL_POPOVER > MODAL`. The Add-to-Calendar menu is triggered from within
 * the details modal and is portalled to `<body>` (so it escapes the modal's
 * stacking context), which means its `z-index` competes directly with the
 * modal's. If this ordering inverts, the popover disappears behind the modal.
 * `z-index.test.ts` asserts the inequality so the regression can't recur
 * unnoticed.
 *
 * ## Tailwind v4 note
 *
 * Tailwind v4 generates `z-<integer>` utilities dynamically, but only for the
 * literal class strings its scanner can see in source. The full literals
 * (`"z-100"`, `"z-110"`, …) are therefore spelled out below as constants so the
 * scanner emits the matching CSS; components reference these constants instead
 * of writing the magic number inline. Do NOT build these class names by
 * concatenation (e.g. `` `z-${MODAL}` ``) — the scanner can't follow that and
 * the utility would be dropped from the build.
 */

/** Numeric stacking values, ordered low → high. The relative order is the contract. */
export const Z_LAYER = {
  /** Normal page flow (hero, story, event grid). */
  BASE: 0,
  /** An event card's own local stacking context. */
  EVENT_CARD: 10,
  /** Modal backdrop + panel (`AnimatedModal`: details / RSVP dialogs). */
  MODAL: 100,
  /** Popover launched from inside a modal (e.g. Add-to-Calendar). Must be > MODAL. */
  MODAL_POPOVER: 110,
} as const;

export type ZLayer = keyof typeof Z_LAYER;

/**
 * Matching Tailwind class strings — the literals the v4 scanner picks up.
 * Apply via `class={Z_CLASS.MODAL}` (or compose with other utilities).
 */
export const Z_CLASS = {
  BASE: "z-0",
  EVENT_CARD: "z-10",
  MODAL: "z-100",
  MODAL_POPOVER: "z-110",
} as const satisfies Record<ZLayer, string>;
