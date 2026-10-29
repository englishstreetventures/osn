/**
 * The portal's two field heights, and the height of a button beside a field.
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
 * The call site sets every one of these heights. A shared `Input` is 28px at
 * `sm` and 36px at `md`, but a shared `Select` has no height of its own at
 * either size: its padding plus the font's line, which the platform sets —
 * 28px for an `sm` select on macOS, 27px on Linux. Every shared class is
 * `base:` (zero specificity), so a plain class here wins whatever the
 * stylesheet order.
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
 * Give it to every filter, an `Input` or `Select` at `size="sm"`, before any
 * class of the call site's own: 28px whatever the platform's font, so the 14px
 * corner is half the height and rounds the ends. An `Input` is 28px at `sm`
 * already; it takes the class too, so every filter carries one rule.
 */
export const FILTER_FIELD_CLASS = "h-7";

/**
 * Give it to a boxed `Button` (`primary`, `outline`, `quiet`, `danger`) in a row
 * with a form field: Add item, Add payment, Add guest, Delete household and the
 * like. A `Button` is `inline-flex` and centred, so its label stays centred at
 * the height whatever its padding. Not for a borderless variant, which draws no
 * box to size, nor for a toolbar's action beside a filter, which is the
 * filter's 28px.
 */
export const FORM_ACTION_CLASS = "h-8.5";
