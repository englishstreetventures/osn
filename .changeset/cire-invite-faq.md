---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
"@cire/invites": minor
"@cire/theme": minor
---

The guest invite gains an optional FAQ section under the events: questions the
couple answers for their guests, each answer opening from its question.

Migration 0064 adds the `wedding_faqs` table (question, answer, `sort_order`,
indexed on `(wedding_id, sort_order, id)`) and the section's switch,
`faq_visible` on `wedding_invite_customisations` (NOT NULL, default on, no
backfill). A wedding holds at most 30 entries; a question is at most 200
characters and an answer at most 1000, both required. The organiser writes them
through `POST /invite/faqs`, `PUT /invite/faqs/:faqId`,
`PUT /invite/faqs/order` and `DELETE /invite/faqs/:faqId` (owner and editors),
and reads them with `GET /invite?include=faqs`. `PUT /invite/visibility` takes
`faq`. The claim response carries `faq: { visible, entries }`, with no entries
while the section is switched off; the public invite read never carries them.
`VISIBILITY_SECTIONS` in `@cire/theme` gains `faq`.

The builder gets a FAQ tab between Events and Closing with add, edit, delete and
drag-to-reorder; entries apply at once, and the switch saves with the others.
Both design packs render the section on the events section's surface. The dev
seed carries three entries.
