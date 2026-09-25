---
"@cire/api": patch
---

Normalise each guest RSVP reply's dietary presets once per submit, and count a repeated preset once.

`POST /api/rsvp` added `other` to each reply's preset list (when free text is present) twice: once
to build the write and once again in the `cire.rsvp.dietary_preset.selected` counter loop. The route
now builds the normalised replies once, after every gate has passed, and both the write and the
counter read them. The shared upsert builder in `services/rsvp.ts` likewise serialised each reply's
presets twice, once for the insert and once for the conflict update; it now serialises them once.

The counter also counted a preset once per repeat within a reply. The schema accepts
`["nuts", "nuts"]` and the row stores `nuts` once, but the counter went up by two. It now counts
each distinct preset once per submitted reply, matching the row. Stored rows are unchanged.
