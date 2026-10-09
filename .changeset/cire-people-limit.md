---
"@cire/api": minor
"@cire/host": minor
---

People limit per tier: a wedding may hold 6 people besides the couple on Ivory, 15 on Gold and 40 on Crimson. Every seat below owner counts, and so does every owner beyond the first two.

The API checks the limit inside the statement that writes — the seat INSERT, and the role UPDATE when one owner moves another below owner — so two requests racing for the last place cannot both win. An owner stepping down from their own seat is always allowed, and lowering a tier removes no one: a wedding over its limit keeps everyone and adds no one until it is under. A refused write answers 409 `people_limit_reached` with `{ used, limit, tier }`, and `GET`, `POST`, `PUT` and `DELETE` on `/hosts` carry `peopleLimit`. Re-adding a seated profile now answers 409 `already_host` on D1 rather than 500.

The co-host panel shows "4 of 6 people" to every member. At the limit an owner sees why and an upgrade button in place of the add form; a wedding with one owner keeps an "Add as owner" form, behind a confirmation, for the partner.
