/**
 * The height of a button beside a form field, and the card bar that holds a
 * row of fields.
 *
 * A form field — any `Input` or `Select` that enters or edits a value — is
 * 34px, the shared control's `form` size (or `form-compact` in a narrow cell),
 * so the 14px field corner leaves a straight side and the box reads as a form
 * field. A filter is `size="sm"`, 28px, where the same corner rounds the ends
 * and reads as a search box. A boxed `Button` in a row with a form field takes
 * the field's height, so the row lines up (owner, 2026-10-29; DESIGN.md §4,
 * "One form-field height").
 */

import { cardClass } from "@cire/ui/card";

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
// Until `Button` has a 34px height of its own: englishstreetventures/osn#1884.
export const FORM_ACTION_CLASS = "h-8.5";
