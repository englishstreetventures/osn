---
"@shared/ui": minor
"@tools/lab": patch
---

`OtpInput` fits a phone, names its boxes from a label, and puts focus where it says.

- The boxes share the column's width, up to 48px each and 48px tall, so the row fits a 212px column on a 320px phone; from a 328px column up it is the same six 48px squares as before.
- New optional `aria-labelledby` (the visible label's id): the group takes the label's name and box N is named "<label> Digit N". Without it the names stay "Verification code" and "Digit N".
- New optional `aria-describedby`, set on every box; every box is `aria-invalid` while `status` is `error`.
- `autofocus` and the refocus after an error focus box 1 one task later, once it is enabled, so they land when the caller re-enables the boxes in the same run and inside a Kobalte dialog.
- Focus draws the text field's 2px `--ui-focus` ring 2px off the ground, with an outline a contrast theme paints on the focused box only.
- The value has no gaps: focus past the first empty box moves to it, typing over a digit replaces it, Delete and a cut remove one, and an autofill of the whole code is taken whole (no box has `maxlength`).

The lab's `shared/ui/forms` group draws it as `Otp`, `OtpStates` and `OtpNarrow`.
