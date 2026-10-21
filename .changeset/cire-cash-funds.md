---
"@cire/api": minor
"@cire/db": minor
"@cire/host": minor
"@cire/invites": minor
"@tools/e2e": patch
---

A couple can list named cash funds — a honeymoon, a house deposit — and guests choose one when they give money through Stripe Checkout. Guests see a fund's name, picture and description, never its goal or what has come in.

- `@cire/db`: migration 0088 adds `registry_contributions.item_title`, the fund's name as the guest saw it, and copies the current title onto every gift that names a listing. The dev seed has a fund.
- `@cire/api`: `POST /registry/items` takes `kind: "cash_fund"` and a `targetMinor` goal, and refuses a field of the other kind with `400 invalid_item_fields` on create and edit. The guest list carries funds in their own `funds` array, offered only while money can be taken, a deployment's Stripe key included; without one, `cashGiftsEnabled` is false too. A fund's picture serves only while the fund is offered. A gift whose `itemId` is not a cash fund of this wedding is refused `409 fund_unavailable` before any row is written or Stripe is asked, and a fund cannot be reserved. A gift keeps its fund's name, so the gift log and `gifts.csv` still name it after the fund is renamed or deleted. `cire.registry.item.write` gains a `kind` attribute.
- `@cire/invites`: the money panel asks what the gift is for — the couple's choice, or one of their funds. A fund that closed while the page was open is said so and the list re-read. The teaser band's picture row includes fund pictures.
- `@cire/host`: the gift list adds and edits cash funds, with the goal shown to the couple only. Publishing counts a fund only while money gifts are on. A fund an older API saved as a gift is deleted at once.
- `@tools/e2e`: the gift-list wedding has a cash fund and Stripe-ready settings; the claimed flow checks that neither money nor the fund is offered on a stack with no Stripe key.
