---
"@cire/dietary": patch
"@cire/ui": patch
"@cire/host": patch
"@cire/invites": patch
---

Show dietary requirements the page build does not know yet. The vocabulary grows on the server first, and an open page keeps the build it loaded with, so a saved answer can carry a key that build lacks. `presetLabel(key)` in `@cire/dietary` labels such a key from its own words (`no_pork` reads "No pork"), and `presetLabels` and `formatDietaryCell` now list it after the known ones instead of dropping it. The organiser's RSVP table, search and picker summary show it, so a row whose only answer is such a key no longer reads "--". The guest sheet shows it as a checked pill the guest can untick.

The privacy-choices dialog's withdrawal sentence now reads "Turning something off takes effect at once; the page may reload. Data already sent can't be recalled."
