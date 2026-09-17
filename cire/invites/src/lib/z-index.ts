/**
 * Single source of truth for the guest site's stacking order.
 *
 * Every overlay/floating element in `cire/invites` pulls its `z-index` from
 * here rather than hardcoding a `z-<n>` utility at the call site, so a new
 * overlay cannot silently regress the layer stack.
 *
 * ## The layers (low → high)
 *
 * | Layer           | z   | What sits here                                          |
 * | --------------- | --- | ------------------------------------------------------- |
 * | `BASE`          | 0   | Normal page flow — hero, story, event grid (default).   |
 * | `EVENT_CARD`    | 10  | An event card's own local stacking context.             |
 * | `STICKY_RAIL`   | 20  | The gift list's sticky return rail.                     |
 * | `MODAL_POPOVER` | 110 | The Add-to-Calendar menu.                               |
 * | `TOAST`         | 150 | Confirmation toasts (`@shared/toast` `<Toaster>`).       |
 * | `CONSENT`       | 200 | Site-wide consent banner (`ConsentBanner`).             |
 *
 * There is no modal layer. The details and RSVP sheets are `@shared/ui`'s
 * `Modal`, a `<dialog>` opened with `showModal()`, which paints in the TOP
 * LAYER — above every stacking context in the document, whatever number
 * anything here carries. So no entry here can rank against a sheet, and the
 * two things that must appear over one (the Add-to-Calendar menu, the toast
 * container) get there by entering the top layer, never by out-numbering it.
 *
 * ## The invariants
 *
 * A toast MUST sit below consent, i.e. `TOAST < CONSENT`. A "just make it big"
 * z-index satisfies every lower bound while violating that upper one, so
 * `InvitePage.browser.test.tsx` asserts the container's MEASURED value against
 * both bounds rather than just "above the page", and `z-index.test.ts` pins the
 * relationship between the constants themselves.
 *
 * A toast must also clear ordinary page furniture, and the `<Toaster>` must be
 * mounted at the page root rather than inside the events section, whose Motion
 * One transform makes it a stacking context that no `z-index` can escape.
 *
 * The consent banner sits above every OTHER numbered layer, deliberately and
 * with a wide gap. It is the guest's route to granting — or later withdrawing —
 * permission for third-party content, and a consent control the guest cannot
 * reach is worse than no control at all, because the stored record would then
 * assert a freely-given choice they had no practical way to change. While a
 * sheet is open the banner is painted beneath it and inert, and comes back when
 * the sheet closes. The gap that leaves — a consent affordance beside a
 * third-party embed the guest is looking at right then — is `xchromo/osn#1061`.
 *
 * The preferences DIALOG has no layer here because it has nothing left to rank
 * against: it is an `@shared/ui` `Modal` too, so opening it from inside a sheet
 * makes it the blocking dialog and the sheet goes inert beneath it.
 *
 * ## Tailwind v4 note
 *
 * Tailwind v4 generates `z-<integer>` utilities dynamically, but only for the
 * literal class strings its scanner can see in source. The full literals
 * (`"z-110"`, `"z-150"`, …) are therefore spelled out below as constants so the
 * scanner emits the matching CSS; components reference these constants instead
 * of writing the magic number inline. Do NOT build these class names by
 * concatenation (e.g. `` `z-${TOAST}` ``) — the scanner can't follow that and
 * the utility would be dropped from the build.
 *
 * @see wiki/decisions/top-layer-over-z-index-stack.md — why nothing here ranks
 * against a sheet, and the two failures that decided it.
 */

/** Numeric stacking values, ordered low → high. The relative order is the contract. */
export const Z_LAYER = {
  /** Normal page flow (hero, story, event grid). */
  BASE: 0,
  /** An event card's own local stacking context. */
  EVENT_CARD: 10,
  /**
   * A sticky page rail — today the gift list's return link, which stays put
   * while the list scrolls under it. Must be > EVENT_CARD and > BASE: every
   * card on that page paints a background of its own and is LATER in the
   * document, so without a layer of its own the rail is painted over by the
   * list it is meant to float above. Below every overlay, like all page
   * furniture.
   */
  STICKY_RAIL: 20,
  /**
   * The Add-to-Calendar menu. Named for where it is usually opened from —
   * inside the details sheet — though that case is settled by the top layer
   * rather than by this number; see the note above. What the number decides is
   * the other case: the same menu opened from an event card, where it has to
   * clear the cards and the sticky rail.
   */
  MODAL_POPOVER: 110,
  /**
   * Transient confirmation toasts (`@shared/toast`'s `<Toaster>`). Must stay
   * < CONSENT — see the invariants above. Above a sheet is the top layer's
   * job, not this number's.
   *
   * Applied as `class={Z_CLASS.TOAST}`, like every other layer here:
   * `@shared/toast` sets no `z-index` of its own, precisely so the layer is the
   * consumer's to state, and the two-sided bound in
   * `InvitePage.browser.test.tsx` is what keeps it honest.
   */
  TOAST: 150,
  /** Site-wide consent banner. Above every page overlay. */
  CONSENT: 200,
} as const;

export type ZLayer = keyof typeof Z_LAYER;

/**
 * Matching Tailwind class strings — the literals the v4 scanner picks up.
 * Apply via `class={Z_CLASS.TOAST}` (or compose with other utilities).
 */
export const Z_CLASS = {
  BASE: "z-0",
  EVENT_CARD: "z-10",
  STICKY_RAIL: "z-20",
  MODAL_POPOVER: "z-110",
  TOAST: "z-150",
  CONSENT: "z-200",
} as const satisfies Record<ZLayer, string>;
