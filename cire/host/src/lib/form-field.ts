/**
 * The card bar that holds a row of fields.
 *
 * A form field — any `Input` or `Select` that enters or edits a value — is
 * 34px, the shared control's `form` size (or `form-compact` in a narrow cell),
 * so the 14px field corner leaves a straight side and the box reads as a form
 * field. A filter is `FilterSearch` or `FilterSelect`, 28px, where the same
 * corner rounds the ends and reads as a search box. A boxed `Button` in a row
 * with a form field is `size="form"`, the field's height, so the row lines up
 * (DESIGN.md §4, "One form-field height").
 */

import { cardClass } from "@cire/ui/card";

/**
 * A bar of fields on a card, at the card's small step: an add form (an item, a
 * task, a vendor, a gift) or a filter bar. The fields wrap in a row, aligned on
 * their foot so a field with a hint and one without share a baseline.
 */
export const FIELD_BAR_CLASS = `${cardClass({ padding: "sm" })} flex-row flex-wrap items-end gap-3`;
