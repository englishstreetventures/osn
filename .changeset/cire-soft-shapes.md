---
"@cire/host": patch
"@cire/vendor": patch
"@cire/invites": patch
"@cire/landing": patch
"@cire/api": patch
"@tools/e2e": patch
---

Every cire surface takes the softer shapes: action buttons are pills with sentence-case labels, text fields and tiles have 14px corners, cards and centred dialogs 16px, popovers, menus, tooltips and toasts 10px, and small marks 6px or 2px. The four app stylesheets map one radius scale and one motion ladder, and a test holds them equal.

- `@cire/host`, `@cire/vendor`, `@cire/invites`, `@cire/landing`: each stylesheet maps the `control`, `field` and `lg` radius roles (pill, 14px, 16px) and raises `sm` to 6px and `md` to 10px. The guest site and the marketing site gain the host's `--dur-*` ladder, its `pointer: fine` block and its easings. Hand-written corners move onto the roles, raw buttons that match a `Button` variant become one, uppercase button and link labels become sentence case, and literal UI durations move onto `--dur-*`. Invitation designs' frames soften with the rest; their type, ornament and colour are unchanged.
- `@cire/invites`: "Event details", "Open invitation" and "Enter your code" are sentence case in the source, and the tests and flows that find them by name moved with them.
- `@cire/vendor`: a browser test project, a dashboard screenshot test, and a test that the four cire stylesheets carry the same radius scale, motion ladder and unchecked-checkbox rule; `turbo.json` re-runs it when another app's stylesheet changes. `DESIGN.md` names where `Chip`, `Checkbox` and `Loading` live now.
- `@cire/host`, `@cire/vendor`, `@cire/invites`, `@cire/landing`: a control that takes focus fades only its text, background, border and underline colours on hover, so its focus ring shows the moment focus lands rather than fading in.
- `@cire/host`: `DESIGN.md` §4 states the radius roles, every small step that remains, and that a colour hover on a focusable control names its properties rather than `transition-colors`; §7 names `Button`'s sixteen variants by group and their corner rule.
- `@cire/host`: every form field is 34px, whatever its size — the forms and modals, the event drawer, the guest editor's cells, the budget, the registry, the co-host form and the vendor list — so its 14px corner leaves a straight side, and a boxed button in a row with one is 34px too: Add item, Add payment, Add guest, Delete household, Add host and the like. A filter — the guest-list and RSVP search boxes, the RSVP sort select, and now the vendor directory's Category, Keyword and Location and the seating chart's Event select — is 28px with round ends, and so are the buttons beside one: Add household, Clear filters, Print and Download seating CSV.
- `@cire/vendor`: every form field in the listing editor and the enquiry thread's quote form is 34px, the host portal's one form-field height, and the dashboard's browser test measures each.
- `@cire/host`, `@cire/vendor`, `@cire/invites`, `@cire/landing`: an unchecked checkbox or radio sits on its surface — no fill, a strong hairline edge, the native box's size — and a checked one keeps the browser's own fill and tick.
- `@cire/landing`: the hero and closing calls to action are pills with sentence-case labels.
- `@cire/api`: the daily RSVP summary's stop page draws its button as a pill.
- `@cire/host`, `@cire/vendor`, `@cire/invites`, `@cire/landing`: markup that duplicated a shared part uses it — `Loading`, `Notice`, `Select`, `Textarea`, `cardClass` and `Chip` in the host portal — and values that bypassed the tokens read them: line heights, type sizes, focus rings, durations and the display face. Display lines take `leading-ui-none`, so descenders draw whole.
- `@tools/e2e`: a `cire-soft-shapes` flow measures the corners on the host guest list, guest editor and RSVP table and on both invitation designs and their RSVP sheet, at phone and desktop widths in light and dark, and keeps the screenshots. It checks the search boxes and the RSVP sort select are 28px filters with round ends, the guest editor's fields, Delete household and Add guest 34px, and Add household 28px. The organiser sign-in cap rises from six to seven.
