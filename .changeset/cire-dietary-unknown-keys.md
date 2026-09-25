---
"@cire/ui": patch
"@cire/invites": patch
---

Keep a dietary preset key the page does not know through an edit, and let a claim response without the dietary fields open the invite.

`DietaryPresets` rebuilt its selection from the vocabulary it shipped with, so ticking or unticking any pill dropped a key the server had added since the page was built, and the next save stored the shorter answer under fresh consent. It now hands such keys back after the ones it knows. Its props take a key type (`DietaryPresetsProps<K extends string = DietaryPreset>`), so a caller whose selection may hold unknown keys can say so. Existing callers are unchanged.

The guest site's claim guard rejected any RSVP row that lacked `dietaryPresets` or `dietaryConsentCurrent`, and both callers read a rejection as "no session". It now checks each field only when present: absence reads as no presets and a consent box that opens unticked, and a present field of the wrong type still fails. `RsvpSummary` types both as optional, and the preset keys as strings.

The RSVP sheet now checks the rows a successful save returns with the same row check, instead of casting them. A save whose rows fail it is still confirmed, and the page keeps the answers it already had.
