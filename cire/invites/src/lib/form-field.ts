/**
 * The guest site's one form-field height: every text field a guest types in —
 * the code field, the email box, a plus-one's names, the RSVP sheet's
 * "Anything else", the gift page's amount, name, quantity and "From" — is
 * `h-8.5`, with the 14px field corner (owner, 2026-10-29; the cire apps' rule,
 * cire/host/DESIGN.md §4, "One form-field height").
 *
 * `h-8.5` is 2.125rem: 34px at this site's 16px root, 36.125px from 1024px,
 * where the root steps to 17px and every rem on the page grows with it.
 *
 * `py-1` replaces each field's own vertical padding rather than sitting beside
 * it: these are hand-written `<input>`s, and two plain `py-*` classes on one
 * element are settled by stylesheet order, not by the order in the attribute.
 * A phone sets the text at `text-base`, 16px on a 24px line (iOS zooms into
 * anything smaller), and `py-1` leaves that 24px inside 34px. A `<textarea>`
 * keeps its rows.
 */
export const FORM_FIELD_CLASS = "h-8.5 py-1";
