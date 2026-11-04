/**
 * The portal's two field heights, the height of a button beside a field, and
 * the card bar that holds a row of fields.
 *
 * A form field — any `Input` or `Select` that enters or edits a value, at
 * either size — is 34px, so the 14px field corner leaves a straight side and
 * the box reads as a form field. A filter is not a form field: the guest-list
 * and RSVP search boxes, the RSVP sort select, the vendor directory's filters
 * and the seating chart's event select are `size="sm"` at 28px, where the same
 * corner rounds the ends and reads as a search box. A boxed `Button` in a row
 * with a form field takes the field's height, so the row lines up (owner,
 * 2026-10-29; DESIGN.md §4, "One form-field height").
 *
 * The call site sets these heights. A shared `Input` and `Select` are 28px at
 * `sm` and 36px at `md`; the shared control's `form` and `form-compact` sizes
 * are 34px and take this module's place in englishstreetventures/osn#1842.
 * Every shared class is `base:` (zero specificity), so a plain class here wins
 * whatever the stylesheet order.
 */

import { cardClass } from "@cire/ui/card";

/**
 * Give it to every `Input` and `Select` that enters or edits a value, before
 * any class of the call site's own. Height only: `shadcn/no-restyle` lets a
 * call site size a shared part but not pad or restyle it, and the engine
 * centres the text in the 34px box. Not for a `Textarea`, which
 * `base:min-h-15` holds at its own height.
 */
export const FORM_FIELD_CLASS = "h-8.5";

/**
 * Give it to every filter, an `Input` or `Select` at `size="sm"`, before any
 * class of the call site's own: 28px, so the 14px corner is half the height
 * and rounds the ends. Both are 28px at `sm` already; the class restates it.
 */
export const FILTER_FIELD_CLASS = "h-7";

/**
 * A bar of fields on a card, at the card's small step: an add form (an item, a
 * task, a vendor, a gift) or a filter bar. The fields wrap in a row, aligned on
 * their foot so a field with a hint and one without share a baseline.
 */
export const FIELD_BAR_CLASS = `${cardClass({ padding: "sm" })} flex-row flex-wrap items-end gap-3`;

/**
 * Give it to a boxed `Button` (`primary`, `outline`, `quiet`, `danger`) in a row
 * with a form field: Add item, Add payment, Add guest, Delete household and the
 * like. A `Button` is `inline-flex` and centred, so its label stays centred at
 * the height whatever its padding. Not for a borderless variant, which draws no
 * box to size, nor for a toolbar's action beside a filter, which is the
 * filter's 28px.
 */
export const FORM_ACTION_CLASS = "h-8.5";
