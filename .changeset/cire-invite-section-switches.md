---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
"@cire/invites": minor
"@cire/theme": minor
---

The invite's hero, Our Story and closing section each get a visibility switch,
so an organiser can hide a filled-in section and bring it back with its content
intact. A section renders on the guest invite only when it is switched on and
has content; switched on but empty still renders nothing, and the builder says
why.

Migration 0063 adds `hero_visible`, `story_visible` and `footer_visible` to
`wedding_invite_customisations` (NOT NULL, default on) and sets each existing
row's switches to what the emptiness check gave before it: content ⇒ on, no
content ⇒ off. `PUT /api/organiser/weddings/:weddingId/invite/visibility` takes
a partial `{ hero?, story?, footer? }` of booleans (owner and editors). The
organiser read returns `visibility` for all three; the public read returns the
hero and story switches and leaves out a switched-off story's content, a
switched-off hero's subtitle and the organiser-only `inviteMessage`; the claim response's `closing` gains `visible`
and carries no content when it is off. `@cire/theme` exports
`VISIBILITY_SECTIONS`, `SectionState` and `sectionState`. The builder shows a
"Show on the invite" switch, a three-state badge and a reason line on each of
the three sections, and saves the switches with the rest of the draft.
