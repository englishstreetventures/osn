/**
 * The portal's one form-field height, and the height of a button beside a field.
 *
 * A form field — any `Input` or `Select` that enters or edits a value, at
 * either size — is 34px, so the 14px field corner leaves a straight side and
 * the box reads as a form field. A filter in a view bar is not a form field: the
 * guest-list and RSVP search boxes and the RSVP sort select stay `size="sm"`
 * alone, 28px, where the same corner rounds the ends and reads as a search box.
 * A boxed `Button` in a row with a form field takes the field's height, so the
 * row lines up (owner, 2026-10-29; DESIGN.md §4, "One form-field height").
 *
 * The shared sizes are 28px (`sm`) and 36px (`md`, where a `Select` has no
 * height of its own), so the call site sets 34px. Every shared class is `base:`
 * (zero specificity), so a plain class here wins whatever the stylesheet order.
 */

/**
 * Give it to every `Input` and `Select` that enters or edits a value, before
 * any class of the call site's own. Height only: `shadcn/no-restyle` lets a
 * call site size a shared part but not pad or restyle it, so an `md` field
 * keeps its `py-2`, and the engine centres its 14.4px text in the 34px box. Not
 * for a `Textarea`, which `base:min-h-15` holds at its own height.
 */
export const FORM_FIELD_CLASS = "h-8.5";

/**
 * Give it to a boxed `Button` (`primary`, `outline`, `quiet`, `danger`) in a row
 * with a form field: Add item, Add payment, Add guest, Delete household and the
 * like. A `Button` is `inline-flex` and centred, so its label stays centred at
 * the height whatever its padding. Not for a borderless variant, which draws no
 * box to size, nor for a toolbar's action beside a filter, which is the
 * filter's 28px.
 */
export const FORM_ACTION_CLASS = "h-8.5";
