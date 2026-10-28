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
- `@cire/vendor`: a browser test project, a dashboard screenshot test, and a test that the four cire stylesheets carry the same radius scale and motion ladder; `turbo.json` re-runs it when another app's stylesheet changes. `DESIGN.md` names where `Chip`, `Checkbox` and `Loading` live now.
- `@cire/host`: `DESIGN.md` §4 states the radius roles and every small step that remains; §7 names `Button`'s sixteen variants by group and their corner rule.
- `@cire/landing`: the hero and closing calls to action are pills with sentence-case labels.
- `@cire/api`: the daily RSVP summary's stop page draws its button as a pill.
- `@cire/host`, `@cire/vendor`, `@cire/invites`, `@cire/landing`: markup that duplicated a shared part uses it — `Loading`, `Notice`, `Select`, `Textarea`, `cardClass` and `Chip` in the host portal — and values that bypassed the tokens read them: line heights, type sizes, focus rings, durations and the display face. Display lines take `leading-ui-none`, so descenders draw whole.
- `@tools/e2e`: a `cire-soft-shapes` flow measures the corners on the host guest list and RSVP table and on both invitation designs and their RSVP sheet, at phone and desktop widths in light and dark, and keeps the screenshots. The organiser sign-in cap rises from six to seven.
