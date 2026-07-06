---
"@cire/api": minor
"@cire/db": minor
"@cire/web": minor
"@cire/organiser": minor
---

The guest site's invite-code entry form and post-claim welcome banner join the
invite theme as a fourth named section, `welcome` — they were previously pinned
to the built-in green/gold tokens with no organiser control.

- `@cire/db`: nullable `welcome_accent_color` + `welcome_surface_color` columns
  on `wedding_invite_customisations` (forward-only D1 migration
  `0027_welcome_theme.sql`; NULL ⇒ built-in token, so existing weddings render
  unchanged).
- `@cire/api`: `welcomeAccentColor` / `welcomeSurfaceColor` in the total
  `PUT /invite/theme` body (same strict colour allow-list) and a
  `theme.welcome` section on the invite reads.
- `@cire/organiser`: a "Code Entry & Welcome" accent/background picker row in
  the Invite Builder's Theme fieldset, plus a matching live-preview card.
- `@cire/web`: `LoginSection` applies the validated `--invite-*` variables for
  the `welcome` section. Its hover/focus states live in Tailwind pseudo-class
  utilities, so the section wrapper re-points the scoped `--color-gold` /
  `--font-*` tokens at those variables (with the built-in literals as
  fallbacks) — accent, background, and fonts follow the organiser's picks in
  every state, and a payload without `welcome` (pre-migration API) renders
  exactly as before.
