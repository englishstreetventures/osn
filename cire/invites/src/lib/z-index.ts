/**
 * Single source of truth for the guest site's stacking order.
 *
 * Every overlay/floating element in `cire/invites` should pull its `z-index` from
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
 * | `TOAST`         | 150 | Confirmation toasts (`@shared/toast` `<Toaster>`).       |
 * | `CONSENT`       | 200 | Site-wide consent banner (`ConsentBanner`).             |
 * | `CONSENT_DIALOG`| 210 | Consent preferences dialog, opened from the banner.     |
 *
 * ## The invariants
 *
 * A popover launched from inside a modal MUST sit ABOVE that modal, i.e.
 * `MODAL_POPOVER > MODAL`. The Add-to-Calendar menu is triggered from within
 * the details modal and is portalled to `<body>` (so it escapes the modal's
 * stacking context), which means its `z-index` competes directly with the
 * modal's. If this ordering inverts, the popover disappears behind the modal.
 * `z-index.test.ts` asserts the inequality so the regression can't recur
 * unnoticed.
 *
 * A toast MUST sit above the modal, i.e. `TOAST > MODAL`. The RSVP save toast is
 * raised while the RSVP sheet is still open (`SAVED_DWELL_MS`), so if this
 * ordering inverts the toast paints behind the sheet's backdrop — the same
 * invisible-but-present failure as #203, and the reason the `<Toaster>` must
 * also be mounted at the page root rather than inside the events section, whose
 * Motion One transform makes it a stacking context that no `z-index` can escape.
 *
 * It must ALSO sit below consent, i.e. `TOAST < CONSENT`. That half is easy to
 * lose: a "just make it big" z-index satisfies the lower bound while violating
 * the upper one — which is exactly what the previous library's hardcoded 9999
 * did — so `InvitePage.browser.test.tsx` asserts the measured value against
 * BOTH bounds rather than just "above the modal".
 *
 * The consent layers sit above EVERYTHING, deliberately and with a wide gap.
 * The banner is the guest's only route to granting — or later withdrawing —
 * permission for third-party content, and the gated embeds themselves live
 * inside the details modal. So "manage privacy choices", clicked from a blocked
 * embed inside that modal, must open a dialog that is not buried behind it. A
 * consent control the guest cannot reach is worse than no control at all,
 * because the stored record would then assert a freely-given choice they had no
 * practical way to change.
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
  /**
   * A sticky page rail — today the gift list's return link, which stays put
   * while the list scrolls under it. Must be > EVENT_CARD and > BASE: every
   * card on that page paints a background of its own and is LATER in the
   * document, so without a layer of its own the rail is painted over by the
   * list it is meant to float above. Below MODAL, like all page furniture.
   */
  STICKY_RAIL: 20,
  /** Modal backdrop + panel (`AnimatedModal`: details / RSVP dialogs). */
  MODAL: 100,
  /** Popover launched from inside a modal (e.g. Add-to-Calendar). Must be > MODAL. */
  MODAL_POPOVER: 110,
  /**
   * Transient confirmation toasts (`@shared/toast`'s `<Toaster>`). Must be >
   * MODAL: the RSVP save toast fires the instant the reply lands, while the
   * sheet is still up for its dwell, so a toast below the modal is painted
   * behind the sheet's backdrop and the guest never sees the one confirmation
   * a partial save gets. Must also stay < CONSENT — see the invariants below.
   *
   * Applied as `class={Z_CLASS.TOAST}`, like every other layer here.
   *
   * That is worth a note because it used not to work. `solid-toast` spread its
   * own `defaultContainerStyle` onto the container's inline `style`, and that
   * carried a hardcoded `z-index: 9999`; inline style beats a Tailwind utility,
   * so `containerClassName={Z_CLASS.TOAST}` was silently inert and the toast
   * landed at 9999 — above the consent layers, the one place it must never be.
   * The only override that won was `containerStyle`. `@shared/toast` sets no
   * `z-index` at all, precisely so the layer is the consumer's to state; the
   * two-sided bound in `InvitePage.browser.test.tsx` is what keeps it honest.
   */
  TOAST: 150,
  /** Site-wide consent banner. Above every page overlay, including modals. */
  CONSENT: 200,
  /** Consent preferences dialog. Must be > CONSENT (it is opened from it). */
  CONSENT_DIALOG: 210,
} as const;

export type ZLayer = keyof typeof Z_LAYER;

/**
 * Matching Tailwind class strings — the literals the v4 scanner picks up.
 * Apply via `class={Z_CLASS.MODAL}` (or compose with other utilities).
 */
export const Z_CLASS = {
  BASE: "z-0",
  EVENT_CARD: "z-10",
  STICKY_RAIL: "z-20",
  MODAL: "z-100",
  MODAL_POPOVER: "z-110",
  TOAST: "z-150",
  CONSENT: "z-200",
  CONSENT_DIALOG: "z-210",
} as const satisfies Record<ZLayer, string>;
