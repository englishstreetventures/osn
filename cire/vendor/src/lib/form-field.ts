/**
 * The portal's one form-field height, the host portal's (host DESIGN.md §4,
 * "One form-field height"; owner, 2026-10-29).
 *
 * A form field — any `Input` or `Select` that enters or edits a value, at
 * either size — is 34px, so the 14px field corner leaves a straight side and
 * the box reads as a form field. A shared `Input` is 28px at `sm` and 36px at
 * `md`, and a shared `Select` has no height of its own at either size, so the
 * call site sets it.
 * Every shared class is `base:` (zero specificity), so a plain class here wins
 * whatever the stylesheet order.
 *
 * Height only: `shadcn/no-restyle` lets a call site size a shared part but not
 * pad it, so an `md` field keeps its padding and the engine centres its text.
 * Not for a `Textarea`, which `base:min-h-15` holds at its own height. This
 * portal has no button in a row with a field, so it needs no action height.
 */
export const FORM_FIELD_CLASS = "h-8.5";
