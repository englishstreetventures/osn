---
"@cire/api": minor
"@cire/db": minor
"@cire/web": minor
"@cire/organiser": minor
---

Close the invite-customisation gaps organisers reported: every guest-facing
part of the invite now follows the saved theme, and the remaining hardcoded
copy is editable.

- `@cire/web`: new `sectionTokenBridge` (invite-theme.ts) re-points the global
  design tokens (`--color-gold`, `--color-gold-dim`, `--color-surface`,
  `--font-display`, `--font-body`) at the validated `--invite-*` variables on a
  section wrapper. Fixes the bug where the "Event Details" accent/surface/font
  theme only changed the section header while the event cards, their
  Respond/View buttons, hover states and date lines stayed on the built-in
  gold. The RSVP and event-details modals (which render outside the themed
  section) now receive the same bridge via a new `AnimatedModal.themeVars`
  prop, so they follow the details theme too. The guest page `<title>` follows
  the couple's hero title when set.
- `@cire/db`: migration `0028` adds `details_eyebrow`, `details_heading` and
  `welcome_message` to `wedding_invite_customisations` (all nullable — NULL ⇒
  built-in copy, existing invites render unchanged).
- `@cire/api`: `InviteTextBody` accepts the three new fields (caps 80/160/300,
  trimmed, whitespace ⇒ null) and the invite payload carries
  `details: {eyebrow, heading}` + `welcome: {message}`.
- `@cire/organiser`: the invite builder gains "Code Entry & Welcome" (welcome
  greeting) and "Events Section" (eyebrow + heading) fields, saved with the
  existing Save copy action.
