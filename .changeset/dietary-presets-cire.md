---
"@cire/db": patch
"@cire/api": patch
"@cire/dietary": patch
"@cire/ui": patch
"@cire/invites": patch
"@cire/host": patch
"@cire/landing": patch
---

Store dietary requirements as structured presets alongside the free text.

A new `@cire/dietary` package holds the closed vocabulary — sixteen keys in two
bands, diet and allergies — and the serialise/parse helpers every surface shares.
Migration `0059` adds `rsvps.dietary_presets`, a canonically-ordered comma-separated
key list; `rsvps.dietary` now carries only what a guest typed under "Other".

The Art. 9(2)(a) consent gate widens to cover presets, because a preset is no less
special-category than the sentence it replaces: `halal` and `kosher` reveal
religious belief, `nuts` and `shellfish` reveal health. Both the guest and the
organiser-attested paths reject (422) a reply carrying either kind of dietary data
without consent, and `DIETARY_CONSENT_VERSION` moves to `2026-09-17` for the new
copy. The caterer CSV keeps its existing per-event column — presets and the "Other"
text render into it as one list — so saved spreadsheet formulas still work.
