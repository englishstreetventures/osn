---
---

Conditional invite segments + hard-required event fields for the cire wedding
invite.

Guest invite (`@cire/web`): empty sections are no longer rendered. The hero is
hidden when it has no image, title, and subtitle; "Our Story" is hidden when its
heading, body, and image are all absent; an event's Inspiration (Pinterest
moodboard) and Dress Code segments only render when the event actually has that
content. "Absent" now also covers whitespace-only values. New shared emptiness
predicates (`invite-emptiness.ts`) are the single source of truth.

API (`@cire/api`): every event must have a Location and a Start. The spreadsheet
parser now treats Location as a required column and rejects any event row missing
a Location (or Start) with a clear, row-scoped error that the organiser import
preview surfaces.

Organiser (`@cire/organiser`): the invite builder shows a per-section
"Shown" / "Hidden — empty" badge on the Hero and Our Story sections — mirroring
the exact guest-side emptiness logic, updating live as the organiser types — and
lists Location among the required import columns. The live theme preview is
unchanged.
