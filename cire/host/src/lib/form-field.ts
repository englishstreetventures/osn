/**
 * The height of a small field that edits a value.
 *
 * `Input` and `Select` at `size="sm"` are 28px tall, and the field corner is
 * 14px, so a small field draws round ends. That is right for a filter in a view
 * bar — the guest-list and RSVP search boxes, the RSVP sort select — which sits
 * beside 28px chips and reads as a search. A field that edits a value — a cell
 * in the guest editor, a budget figure, a co-host's role — takes this class as
 * well: 34px, so the same corner leaves a straight side and the field reads as
 * a form field, not a search box (owner, 2026-10-29; DESIGN.md §4, "The small
 * fields").
 *
 * Give it to every `size="sm"` `Input` or `Select` that edits a value, before
 * any class of the call site's own. Not to a `Textarea`, which `base:min-h-15`
 * already holds taller.
 */
export const SMALL_FORM_FIELD_CLASS = "h-8.5";
