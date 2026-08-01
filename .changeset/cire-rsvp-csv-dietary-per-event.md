---
"@cire/api": patch
---

Export dietary requirements per event in the RSVP CSV.

Reported from the live wedding: a guest was marked "fish only" for the mehendi
and the download showed no dietary note for them at all.

`rsvps.dietary` is stored per (guest, event) — one reply per event, each with its
own field — but the CSV emitted a single aggregate `Dietary Requirements` column,
filled by scanning the guest's replies in event order and taking the first
non-empty one. Any guest with notes on two events silently lost all but one, and
which one survived depended on the events' start times.

There is no correct winner to pick. A guest who eats fish at the mehendi and is
vegetarian at the reception has two true answers, and each event's caterer needs
their own. So the column follows the data: `RsvpExportRow.dietary` is now a
`string[]` index-aligned with the status cells, and the CSV interleaves the pair
— `<Event>`, `<Event> Dietary` — so whoever is catering one event reads its
status and its note side by side. The aggregate column is gone rather than kept
alongside; keeping it would have kept the lossy value on the sheet.

A dietary cell blanks on exactly the condition the status cell blanks on (the
guest isn't invited to that event), so a reply that outlived its invitation can't
show a requirement beside an empty status.

The in-dashboard RSVP view was already per-event and is unchanged — which is why
the note was visible in the portal but not in the download.
