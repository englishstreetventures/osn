---
"@cire/api": minor
"@cire/db": patch
"@cire/host": minor
"@cire/invites": minor
"@tools/e2e": patch
---

A couple can list a group gift — one item several households give money towards, which the couple buy themselves. Its target is soft: gifts may pass it, and nothing caps or refunds them. Guests see its name, picture and words and that it is a group gift, never its target, its total or who gave.

- `@cire/api`: `POST /registry/items` takes `allowPartial: true` on a cash fund with a `targetMinor`, and refuses it on a gift to reserve or with no target with `400 invalid_item_fields`; an edit cannot clear a group gift's target. Every organiser read of an item carries `raised` — what a group gift has received, in the wedding's currency, and how many gifts — from the same statement as the wedding's total, and an edit learns it in its own `RETURNING`. The guest list marks a group gift `groupGift: true` among the funds. `cire.registry.item.write` counts `kind: group_gift`.
- `@cire/db`: `allow_partial` and `target_minor` are documented as the group-gift flag and target; no migration. The dev seed lists a group gift.
- `@cire/host`: the gift list adds and edits group gifts. A group gift's row shows what has come in against its target, what is left, and whether the target is reached or passed; the gifts tab lists every group gift together. After the yearly sweep only the target shows. A group gift an older API saves as a plain fund is deleted at once.
- `@cire/invites`: the money panel marks a group gift and says the couple buy it with what comes in. A closed one is said in its own words.
- `@tools/e2e`: the money wedding has a group gift past its target; the money flow reads its status, adds a second through the form and finds both on the gifts tab.
