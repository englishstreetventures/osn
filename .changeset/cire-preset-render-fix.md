---
"@cire/theme": patch
"@cire/web": patch
---

Render a chosen colour scheme rather than the built-in one when the organiser
edited no individual seed.

Picking a preset saves the KEY with five null seeds — by design, so a later
change to a preset's palette reaches every invite that chose it. But a null seed
resolved to the DEFAULT preset, so every scheme rendered as the built-in
evergreen to guests while previewing correctly in the builder. `derivePalette`
now takes the preset and resolves each null seed against it; an unrecognised key
still degrades to the built-in scheme. `resolveSeeds` is now the single
definition of what a half-filled scheme means, shared by the guest render and
the builder preview.

Caught on the live preview tier, which is the only place the whole chain —
organiser save → API → guest render — is visible at once.
