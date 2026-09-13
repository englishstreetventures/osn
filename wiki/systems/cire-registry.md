---
title: Cire gift registry
tags: [system, registry, gifts, money, phase-4, cire]
related:
  - "[[cire-entitlements]]"
  - "[[cire-budget]]"
  - "[[cire-platform-plan]]"
  - "[[cire-consent]]"
  - "[[drag-and-drop]]"
last-reviewed: 2026-09-11
---

# Gift registry

Phase 4 module. The couple curate a gift list; guest **households** claim from it so nobody buys the same thing twice; the couple work from a gift log afterwards to write thank-yous. Card contributions ride Stripe Connect — and everything below is still usable as an honour-system list with no Stripe account at all.

> **It is locked.** The `registry` entitlement is granted to no wedding, so every route in this page answers `402 payment_required` in production today. See [[cire-entitlements]] for the mechanism and the comp-grant CLI. Nothing here is reachable until someone grants it.

---

## Why the module looks like this

Three decisions shape everything else, and each was taken against a specific failure:

1. **Claim ≠ purchase.** A household reserving on the honour system and a household actually sending money are different facts. Collapsing them into one "taken" flag loses what the couple need to know when they sit down to write thank-yous, so claims and contributions are separate tables merged only at read time.
2. **Guests see counts, never names.** A guest sees "1 of 2 left". Who claimed, how much anyone gave, and any running total are couple-only. This is a privacy property, not a UI preference — the guest read path never selects a claimant identity.
3. **A released claim is a tombstone, not a delete.** A guest who changes their mind must be able to free the item. Making that a delete would let the (item, household) unique pair be re-created and re-created, and would lose the fact that they had once claimed it.

---

## Database schema (migration 0057)

### `registry_settings`

One row per wedding, keyed by `wedding_id` (PK + FK cascade). **An absent row reads exactly as `published = 0`**, so a wedding that never opened the registry and one that turned it off are the same state to every caller.

| Column                                                                                               | Notes                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `published`                                                                                          | Guest visibility. The guest read requires this **and** the entitlement — two independent gates, so an entitlement lapsing can't silently republish a registry the couple turned off, and vice versa |
| `headline`, `message`                                                                                | The couple's copy above the list ("no boxed gifts please"). NULL ⇒ nothing renders                                                                                                                  |
| `cash_gifts_enabled`                                                                                 | Off by default and independently of `published`                                                                                                                                                     |
| `shipping_address`, `shipping_visible_from`                                                          | Shown to claimed guests only; the date is the "don't ship until we're back" pattern                                                                                                                 |
| `stripe_account_id`, `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_account_updated_at` | Connect state, cached from the `account.updated` webhook so the portal needs no live Stripe call per page load                                                                                      |
| `stripe_deauthorized_at`, `stripe_deauthorized_account_id` | What a revocation leaves behind. `account.application.deauthorized` NULLs `stripe_account_id` — that is what disarms the guest gate and what lets the couple reconnect, since the attach path only ever fills a NULL — so these two are the only record of which account the wedding's earlier gifts settled into. Nothing in the product reads them |
| `gift_summary_json`, `gift_summary_at` (migration 0058)                                              | What the couple keeps after the 1-year sweep takes the detail: counts and per-currency totals, no household, no name, no note. Written by the sweep itself, immediately before the delete           |

### `registry_items`

`id` (`reg_*`) · `wedding_id` · `kind` (`product` \| `cash_fund`) · `title` · `description` · `image_key` + `image_crop` · `external_url` · `price_minor` · `quantity_wanted` · `allow_partial` · `target_minor` · `category` · `sort_order` · timestamps. Indexed `(wedding_id, sort_order, id)` — every list read filters and orders on exactly that triple, and `id` is in the index because it is the tie-break for equal `sort_order` (without it the sort spills to a temp b-tree).

Two CHECK constraints: `quantity_wanted >= 1` and `kind in ('product','cash_fund')`. The service validates both first and returns a typed error; the constraints are there for the paths the service doesn't own — a fixture, a migration, a future import.

`kind = 'cash_fund'`, `allow_partial` and `target_minor` are declared but unused: they are the named-fund and group-gifting seams, so adding either is UI work rather than a migration.

**`price_minor` carries no currency code.** See [Money](#money) — that is deliberate, not an omission.

### `registry_claims`

`id` (`rcl_*`) · `wedding_id` · `item_id` · `family_id` · `quantity` · `status` (`reserved` \| `purchased` \| `released`) · `note` · `display_name` · `thanked_at` / `thanked_by` · timestamps.

`wedding_id` is denormalised from the item so the gift log filters without a join and a wedding delete cascades even once the item is gone. `display_name` covers "thank Auntie Ros", where the household name isn't who to write to.

**Unique `(item_id, family_id)`.** One row per household per item — re-claiming updates it rather than stacking rows, which is what makes the quantity arithmetic below tractable.

CHECK `quantity between 1 and 99` and `status in ('reserved','purchased','released')`. The 99 ceiling matches `MAX_CLAIM_QUANTITY` in the service: a claim is a household saying how many of a listed gift they will bring, so a four-digit quantity is a typo or an attack, never a fact.

Two covering indexes carry the hot reads. `(item_id, status, family_id, quantity)` serves the claim statement's `sum(quantity)` sub-select — every column it touches is in the index, so the guard never visits the table. `(wedding_id, item_id, status, quantity)` serves the list read's per-item claimed-count rollup for a whole wedding in one index scan.

### `registry_contributions`

One row per Stripe Checkout Session. `stripe_checkout_session_id` is **unique**, and that uniqueness is the webhook idempotency anchor — the same role `provider_ref` plays for entitlement grants. A replayed `checkout.session.completed` conflicts there instead of writing a second gift.

`item_id` is `ON DELETE SET NULL`, not cascade: removing a listing must never erase the record of money someone actually sent.

### Invite copy

`wedding_invite_customisations` gains `registry_eyebrow`, `registry_heading`, `registry_body`, `registry_tone` — the same nullable-means-built-in-default contract as the story/details headers, so every pre-0057 invite renders unchanged.

---

## Money

**The wedding has one primary currency** — `weddings.currency`, already shared with [[cire-budget]]. The registry reuses it and introduces no second source of truth.

- **Everything the organiser authors is in the primary currency.** `registry_items.price_minor` has no currency column of its own. A gift list quoted in four currencies is unreadable, and a per-item currency is the change that makes it one.
- **Only received money can be foreign.** A contribution stores `amount_minor` + `currency` **as given**, plus `primary_amount_minor` + `primary_currency` + `fx_rate` + `fx_rate_at` — the primary-currency equivalent. All four are NULL when the gift arrived in the primary currency, which is the common case, and the UI then shows a single figure.
- **The host reads the as-given amount as the primary visual, with the primary-currency line underneath.** Never a silently converted single figure.
- **Rates are snapshotted per gift and never recomputed.** A gift log that re-values itself whenever rates move is not a record of anything.

The rate comes from **Stripe's balance transaction** (`exchange_rate`), not a third-party FX feed: it is authoritative, free, arrives with a webhook already being handled, and matches what actually reached the couple's bank. No new subprocessor and no scheduled rate fetch. When no balance transaction is available yet the FX columns stay NULL and the figure renders alone — the degraded state is the common state, which is the right way round.

**Totals** sum `primary_amount_minor` only (falling back to `amount_minor` where the currencies already match) and must be labelled approximate: each row was converted at its own snapshotted rate, so the sum is of historical conversions, not a live valuation.

Rendering goes through `formatMinorPair` in `cire/host/src/lib/money.ts`. That module also knows each currency's **real minor-unit exponent** — JPY has none (1000 minor units is ¥1000, not ¥10) and KWD/BHD/JOD use three. The old fixed `/ 100` was invisible while every wedding was in AUD and is wrong by 100× the moment a gift arrives in yen.

### Connecting the account (built)

`cire/api/src/services/stripe.ts` is the client: three REST calls and a signature check over `fetch`, with **no `stripe` package**. The official SDK is built around Node's http stack and cire-api ships inside a 1MB compressed Worker budget it already shares with Elysia, Drizzle and Effect — a trade to re-run if this file ever grows past the handful of calls the gift flow needs, not a principle.

| Route                            | Gate                         | What it does                                                                                                                   |
| -------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `POST …/registry/stripe/session` | `weddingOwner` + entitlement | Creates the connected account (Express, `card_payments` + `transfers`) if there isn't one, then mints a hosted onboarding link |
| `POST …/registry/stripe/refresh` | `weddingOwner` + entitlement | One live `GET /v1/accounts/:id`, and caches what it says                                                                       |
| `POST /api/stripe/webhook`       | Stripe signature             | `account.updated` → caches the capability booleans; `account.application.deauthorized` → clears the account; the seven gift events below |

**Owner-only, not editor.** Every other registry write is `weddingEditor`, because adding a gift is ordinary help. This names the bank account the money lands in, and sits on the same side of the role line as codes, deletion and co-host removal.

**Create-or-resume, never create-again.** Onboarding is a form people abandon and come back to. The route reads the settings row first and reuses any account on it; `stripe_account_id` is written through a `coalesce` so a second create can only fill a null, never repoint a couple's payouts. Stripe's idempotency key (`cire-account-<weddingId>`) is the second belt against a double-tapped button.

**Intent and capability are different columns.** `cash_gifts_enabled` is the couple's decision; `stripe_charges_enabled` is Stripe's. The webhook never touches the first — clearing intent because a capability lapsed would quietly turn the feature off for good, and restoring it later would be us deciding something they never did. `PUT /registry/settings` still refuses to enable cash gifts while Stripe cannot take a charge (`stripe_not_ready`).

**Both halves are key-optional, independently.** No `STRIPE_SECRET_KEY` ⇒ the onboarding routes are not mounted, so a deployment without a Stripe account has no payment surface rather than a broken one. No `STRIPE_WEBHOOK_SECRET` ⇒ the webhook route does not exist: nothing else authenticates it, so an endpoint that writes from unverified bodies would be an unauthenticated write API.

**The webhook check is four things, and all four matter.** The raw request TEXT is the subject (a body parsed and re-serialised has already lost the property being checked); the header must parse; the digest is compared without a length- or value-dependent early exit, against every `v1` Stripe sent (secret rotation); and the timestamp must be inside a 300-second window, because a valid signature is valid forever and without a window a captured delivery can be replayed at any point in the future. A 200 does not mean "handled" — an event type this product does not act on is acknowledged, because the endpoint belongs to the platform account and a non-2xx buys days of retries for something nobody was going to do anything with.

### Giving money (built)

| Route                                                                                                                                         | Gate                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `POST /api/invite/:slug/registry/contribute`                                                                                                  | `sessionAuth` + family-in-wedding + its own per-IP limiter (20/min) |
| `POST /api/stripe/webhook` → `checkout.session.completed`, `.async_payment_succeeded`, `.async_payment_failed`, `.expired`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed` | Stripe signature                                                    |

**The gates run before Stripe does.** `contributionContext` resolves the visible registry, checks the household belongs to THIS wedding, and requires `cash_gifts_enabled` AND `stripe_charges_enabled` AND an account id. A guest is turned away before their card is, or not at all. The cash-specific refusal is its own 409 `cash_gifts_unavailable`, because it is the one a guest looking at the panel can understand; everything else is the same 404 as always.

**Its own limiter, at the claim route's rate** (20/min per IP). Every call is an outbound Stripe request — the "amplifier" shape the link-preview route is limited for — but the limit is per IP and a reception is one NAT: 5/min was reasoned as if it were per household, and it would have met the sixth guest of the evening with a 429 on their way to paying.

**The row is written FIRST, as `pending`, before the guest is handed a payment page.** Stripe is told one opaque id and the money — no wedding, no household, no name, no note. Two things follow. A forged session settles nothing: the webhook settles the row an id names, and there is no row to conjure from an event, which matters because this endpoint also hears about sessions a connected account created for ITSELF, where every metadata field is whatever its owner typed. And no guest personal data crosses to a US processor for a reconciliation that never needed it.

`settleContribution` moves that row to `succeeded` after checking the completed session is the one on the row and that the row's wedding owns the account the event arrived on (`event.account`). It answers `settled` / `duplicate` / `unknown` / `rejected` — at-least-once delivery makes `duplicate` ordinary. **If the row cannot be written the guest is not sent to pay at all**: a payment with no record is the one outcome there is no way back from.

**A checkout session is not over when it completes**, which is why seven events reach the gift rather than one. A delayed bank debit — BECS here, SEPA in Europe — completes the session in seconds and settles days later, so `async_payment_succeeded` runs the same settle path; without it a real gift sat `pending` forever and never reached the couple's log. `async_payment_failed` and `expired` call `failContribution`, which marks a gift whose money is never coming `failed`. `charge.refunded` calls `refundContribution`, which finds its row by **payment intent** — a charge event carries no session — and only when Stripe's own `refunded` flag says the whole charge went back; a partial refund is acknowledged and left alone, since the couple did receive the rest. `charge.dispute.created` and `charge.dispute.closed` call `disputeContribution`, matching on the same payment intent: an opened dispute holds a `succeeded` gift at **`disputed`** — money the guest's bank has taken back while it decides is not money the couple has, and the log should not keep calling it Received — and the close moves it on, back to `succeeded` if they won and to `refunded` if they lost. A `lost` may act on a `succeeded` row too, because `closed` getting through when `created` did not is ordinary. `warning_closed` ends an early-warning enquiry where no money ever moved, and is deliberately ignored.

**A couple can revoke cire from their own Stripe dashboard**, and `account.application.deauthorized` is the only notice of it. The account it names is in the event ENVELOPE — the object is the application, whose id is the platform's own. `detachStripeAccount` NULLs `stripe_account_id` and both capability booleans, which closes the guest gate (it requires an account id) and leaves the couple able to reconnect. It carries no monotonic guard, unlike `applyStripeAccountState`: a revocation arriving late must always close the surface, and a stale `charges_enabled: true` arriving after one matches nothing, because the id it names is gone. `cash_gifts_enabled` is untouched, on the same rule as `account.updated` — that column is the couple's intent, not Stripe's capability. Disputes are also the one gift event that reaches the PLATFORM's balance: Express leaves cire liable for a connected account that goes negative.

**Every one of those transitions is one-way, and guarded in the service rather than the route.** Only a `pending` row may fail; only a `succeeded` row may refund; the row is kept, never deleted. So a replayed — or forged — `expired` from a hostile connected account cannot un-settle a gift somebody actually gave: it answers `ignored`. Each of the three also re-checks that the row's wedding owns the account the event arrived on, in ONE query: `contributionOnAccount` LEFT JOINs the settings row and returns a null account id when it does not match, inside a handler Stripe gives twenty seconds. Migration 0059 indexes `stripe_payment_intent_id` for the refund lookup — deliberately not UNIQUE, since a null-heavy column and Stripe's own idempotency make a constraint a liability rather than a guarantee.

**What the couple see of an unhappy ending.** A `failed` gift is not in the gift log at all: money that never moved is not a gift, and a guest who abandoned a checkout page never meant to tell them anything. A `refunded` one stays visible and out of the totals — a refund is a thing that happened to their record, not an erasure of it. The retention summary counts neither.

**The idempotency key is a hash of the whole request** — household, slug, amount, item, message, name — plus a five-minute bucket, so a double-tap is one attempt and everything else is its own. Folding the note down to its length, as the first cut did, had both failure modes a key exists to avoid: two different gifts of the same amount from one household collided and the second silently never charged, and a retry with different words hit Stripe's `idempotency_error` permanently, because the key never changed.

**FX stays NULL for now.** The primary-currency equivalent comes from the balance transaction's `exchange_rate`, which is not on the checkout event; the four FX columns are all-or-nothing, and a gift in the wedding's own currency — the common case — never needs them.

**The guest surface** (`GiftMoneyPanel`) sits above the shelves and OUTSIDE the items-exist branch, on purpose: a guest who finds every gift taken has not stopped wanting to give something, and an option that appears only once the list runs dry reads as a consolation prize. It takes no card details — the button hands off to Stripe's hosted page — and it says so before the guest presses, along with who reads the name and note they typed (the couple; never the other guests). Amounts are typed in MAJOR units and converted once through the currency's real exponent (`parseGiftAmountMinor`): JPY has none and KWD has three, so a fixed ×100 is wrong by 100× on a payment screen. Coming back, `?gift=thanks` says the gift is _on its way_ rather than that it landed — the row is the webhook's to write, and it may be a second behind the guest.

`PublicRegistryDto.cashGiftsEnabled` is the couple's intent **ANDed** with Stripe's capability, so the guest surface never has to reason about the two separately.

### What the couple keeps (built)

Guest data goes at one year, and gifts go with it — the household, the name a guest typed, the note they wrote. That is right for the personal detail and wrong for the fact that people gave: a couple who opens the registry two years on should not find that their wedding received nothing.

So the sweep writes before it deletes. `writeGiftSummaries` runs inside `sweepExpiredGuestData`, immediately ahead of the delete batch, and leaves one JSON blob per wedding on `registry_settings` — a row the sweep does not touch, because it hangs off the wedding rather than off a guest:

```json
{
  "sweptOn": "2026-06-17",
  "claims": { "reserved": 1, "purchased": 2 },
  "contributions": { "count": 3, "totals": [{ "currency": "AUD", "amountMinor": 17500 }] }
}
```

Three rules it keeps:

- **Only what arrived counts.** Released claims are excluded — a household that changed its mind never bought anything — and only `succeeded` contributions are counted, so a `pending` row that never settled is not money.
- **Totals are per currency, never converted.** A rate from the day of the sweep would make the number a guess; two lines that each say what they are is the honest shape.
- **It never fails the sweep.** A summary that cannot be written is logged and stepped over. The deletion is the obligation; the keepsake is not.

Nothing yet _delivers_ this to the couple — cire has no path to an organiser's email address (that lives in osn-api, behind an ARC route that does not exist). The durable record is the point; sending it is a follow-up.

---

## Claim concurrency

Two guests clicking the last item at the same moment is the **ordinary case** for a registry, not an edge case, and SQLite has no row-level lock a read-then-write can rely on.

`registryService.claim` is therefore a single statement. The remaining-quantity check lives in the INSERT's `WHERE`, so it re-evaluates as part of the write:

```sql
INSERT INTO registry_claims (…)
SELECT …, ri.wedding_id, ri.id, …
FROM registry_items ri
WHERE ri.id = ? AND ri.wedding_id = ?
  AND ? + coalesce((
        SELECT sum(rc.quantity) FROM registry_claims rc
        WHERE rc.item_id = ri.id AND rc.status <> 'released'
          AND rc.family_id <> ?          -- exclude the caller's own row
      ), 0) <= ri.quantity_wanted
ON CONFLICT (item_id, family_id) DO UPDATE SET …
RETURNING id
```

Two details are load-bearing:

- **`rc.family_id <> ?` excludes the caller's own row**, so a household raising its own quantity is measured against _other_ households' claims. That is what lets one statement serve both the first claim and a later change, via the `ON CONFLICT` arm.
- **Success is decided by `RETURNING`**, never by re-reading the `(item_id, family_id)` pair. A household that had _released_ this item still has a row there, so the re-read would report success for a claim the guard refused. There is a test named for exactly this.

Zero rows returned means one of two things; only that failure path pays for a second query to tell `ItemFullyClaimed` (409) from `RegistryItemNotInWedding` (404).

**Timestamps.** This statement writes `created_at` / `updated_at` directly rather than through a Date-valued insert, so it must match drizzle's `integer({ mode: "timestamp" })` unit — **epoch seconds, not milliseconds**. Getting it wrong still writes the row, just dated to the year 58000, so `toEpochSeconds` is pinned by a test against what a normal drizzle insert produces.

---

## API

All organiser routes sit under `/api/organiser/weddings/:weddingId/registry`, gated `osnAuth()` → role gate → **`weddingEntitlement(db, "registry")`** → rate limiter. Ordering matters: a stranger gets 403 from the role gate _before_ the entitlement gate runs, so a 402 never leaks which weddings exist or which features they hold.

| Route                                                                                              | Gate                                                                                                                           |
| -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `GET /registry` — settings + items (with claim counts) + gift log                                  | `weddingMember`                                                                                                                |
| `PUT /registry/settings`                                                                           | `weddingEditor`                                                                                                                |
| `POST /registry/items`, `PATCH /registry/items/reorder`, `PATCH \| DELETE /registry/items/:itemId` | `weddingEditor`                                                                                                                |
| `POST /registry/gifts/:kind/:giftId/thanked`                                                       | `weddingEditor`                                                                                                                |
| `POST /registry/link-preview`                                                                      | `weddingEditor` + **its own** per-organiser limiter — see [Link preview](#link-preview)                                        |
| `POST /registry/image` (raw bytes), `POST /registry/image/from-url`                                | `weddingEditor` + **their own** 10-a-minute limiter — see [Picking one](#picking-one-we-copy-the-bytes-we-never-store-the-url) |
| `GET /registry/image/:name` — serves our R2 copy, `private`                                        | `weddingMember`                                                                                                                |

### Guest routes

Under `/api/invite/:slug/registry`. **The list is not public.** It names what a couple want and what it costs, and they only ever showed it to the people they invited — so the read sits behind the same `cire_session` the rest of the invitation does.

| Route                                                   | Gate                              |
| ------------------------------------------------------- | --------------------------------- |
| `GET /registry` — the published list, with claim counts | `sessionAuth` + family-in-wedding |
| `GET /registry/mine` — this household's own claims      | `sessionAuth`                     |
| `POST \| DELETE /registry/items/:itemId/claim`          | `sessionAuth` + per-IP limiter    |
| `GET /registry/image/:name` — a gift's image bytes      | none — see below                  |

**Every gated route checks the family against the WEDDING**, through one shared `familyInWedding` read, and they must not drift: a `cire_session` names a household, not a wedding, so without it one leaked code reaches every couple's list on the platform. All three answer the same `registry_not_found` a missing, unentitled or unpublished registry gives:

| Route                                          | A household of another wedding gets                                                    |
| ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /registry`                                | `404 registry_not_found`                                                               |
| `GET /registry/mine`                           | `404 registry_not_found` — **not** the empty `200 {claims: []}` it used to give (S-M1) |
| `POST \| DELETE /registry/items/:itemId/claim` | `404 registry_not_found`, because the service checks the family **before** the item    |

The order in `registryService.claim` is the security property, not a detail. Checking the item first told a cookie-holder whether the id they guessed exists on a wedding they cannot read; checking the family first tells them only what they already knew. `releaseClaim` pays one extra point read on its failure path for the same reason — "matched no claim row" would otherwise answer item-shaped on a visible registry and registry-shaped on an invisible one, which is a probe for which weddings have a list.

The image route stays **unauthenticated on purpose**. A name is `registry-<uuid>`, minted per save and reachable only from the list the session now gates, so the bytes are not enumerable without that read — while authenticating them would put a session lookup on every image request on the page, the one place on the guest surface where requests arrive in dozens. If the couple's pictures ever become sensitive on their own, that route moves and `visibility: "public"` moves with it.

`/registry/items/reorder` is registered **before** `/registry/items/:itemId` so the literal wins over the param. `:kind` is decoded through the same Effect Schema a body field would be — an unknown value 400s rather than falling through to a table by coincidence.

### Bounded reads

`GET /registry` returns the settings, every item, and a **page** of the gift log — never the whole log. A wedding with 300 guests can produce a four-figure gift log, and one unbounded read of it on every portal page load is the shape that turns a free-tier D1 read budget into an outage.

- **50 gifts a page** (`GIFT_LOG_PAGE`), with `?giftsOffset=` walking it and **`giftsHasMore`** in the response telling the portal whether to draw a "load more". An unparseable, negative or absurd offset reads as 0 rather than 400ing — a junk query string is a broken link, not an attack worth a status code.
- **The offset is capped** (`MAX_GIFT_LOG_OFFSET` = 500). Paging is offset-based, not keyset, because the log merges two tables whose timestamps are second-granular and share no id order; a cap is what keeps the cost of the deepest page bounded.
- **Totals are computed in SQL, not from the page.** `contributionsPrimaryMinor` is a `sum()` over every `succeeded` contribution. Summing the page instead would under-report the couple's money the moment the log passed 50 entries — silently, and in the direction that looks like a missing gift.
- **500 items a wedding** (`MAX_ITEMS_PER_WEDDING`) — `POST /registry/items` answers **409 `registry_item_limit_reached`** past it. The ceiling is per wedding, not per account.

`PUT /registry/settings` refuses `cashGiftsEnabled: true` with **409 `stripe_not_ready`** unless the wedding's Connect account can actually take charges. Offering a contribute button that 503s is worse than offering none, because the guest believes they paid.

### Taking the log away (`gifts.csv`)

`GET /api/organiser/weddings/:weddingId/gifts.csv` hands the couple their whole gift log as a spreadsheet — the third organiser export, beside `guests.csv` and `events.csv`, and the one that answers a data-portability request (C-L1). It sits on the export route group, so the gate is `osnAuth()` → `weddingMember` → per-user limiter, not the registry entitlement: a couple whose entitlement lapsed must still be able to take their own record out.

The export exists because the two things above are in tension. The portal reads the log **a page at a time** and the retention sweep **deletes the detail after a year**, leaving only the aggregate summary. Between those, the couple have no way to hold the whole thing. A download is that way.

- **It reads the same two tables in the same shape as `registryService.giftLog`** — the same `failed`-contribution exclusion, the same LEFT join for a cash gift with no item, and no host-family exclusion. The rule is that the file matches what the portal shows and nothing else; an export that quietly differs from the screen is a second, unreviewed disclosure surface.
- **A household is named, never coded.** `families.public_id` is the claim code — a bearer credential that opens that household's invite on its own, and the `HOST-*` code opens every event. The portal's gift log does not return it, so neither does the file. A thank-you list needs the household name and the giver's chosen display name; it does not need a set of working sign-ins sitting in a spreadsheet on a laptop or in a mail attachment.
- **The two reads run in parallel** (`Effect.all`, concurrency 2), one D1 round-trip rather than two.
- **Bounded at 2,000 rows** (`MAX_GIFT_EXPORT_ROWS`). An export cannot page, so it is capped instead, and a read that hits the cap **logs a warning** rather than truncating in silence — a portability answer that drops rows without saying so is worse than no answer. The number comes from the **CPU budget, not from how many gifts a wedding plausibly has**: Workers Free allows 10 ms of CPU per invocation ([[free-tier-limits]]), and building the file is dominated by `serialiseCsv`, measured at roughly 6 ms for 2,000 rows and 11 ms for 5,000. Raising the ceiling means streaming the response first.
- **Amounts are bare major-unit decimals with the currency in its own column** — a spreadsheet can sum `125.00`, not `$125.00`. The minor-unit exponent is read off `Intl`, not assumed to be 2: JPY has none and KWD has three, and a fixed `/ 100` is wrong by 100× the moment a gift arrives in yen (`cire/api/src/lib/money.ts`, mirroring the host-side helper).
- **The FX columns carry the snapshot, never a fresh conversion.** `Amount In Your Currency` / `Your Currency` / `Exchange Rate` are the values stored at charge time, blank for a gift that already arrived in the wedding's primary currency.
- **No Stripe identifiers.** The charge and payment-intent references are payment plumbing, not part of the couple's record of who gave what.

Cells are formula-sanitised by `serialiseCsv` like every other export — a guest-authored note beginning `=` opens as text, not as a formula.

The portal side is a single quiet button in the Gifts tab of `RegistryView.tsx`, shown only when there is a gift to export, and it downloads `cire-gifts-<slug>.csv`.

### External URLs

`external_url` must be an absolute `https:` URL, checked at the boundary by parsing it — not by shape-matching. It reaches an `<a href>` on the guest site, and an unvalidated URL there is a same-origin script sink; the precedent is **CON-S-L2**, where `vendor.privacyUrl` reached an `href` with no scheme check. The guest renderer re-checks rather than trusting the column, because a row can also arrive from a migration or a fixture.

The parse also **rejects embedded credentials** (`https://evil.com@retailer.example/…`, which reads as the retailer to a guest and resolves to `evil.com` to the browser) and **stores the parsed `URL.href`**, not the raw input — so what the column holds is the normalised form the browser would resolve, and two spellings of the same URL can't diverge between the check and the render.

`shipping_visible_from` is a calendar date, and its schema round-trips the string through a real `Date` rather than shape-matching `\d{4}-\d{2}-\d{2}`: `2026-02-30` matches the shape and is not a day.

### Images

Registry images are **always our own copy in R2**, through the existing invite-assets pipeline. Never hotlink a retailer image: an off-origin `img-src` breaks the guest site's CSP and would need a vendor entry in the [[cire-consent]] registry. How the bytes get there — upload or picked shop link — is [Picking one](#picking-one-we-copy-the-bytes-we-never-store-the-url) below.

**An `imageKey` must name this wedding's own upload.** Keys are `assets/<weddingId>/<name>`, so an editor on wedding A could otherwise set an item's image to `assets/<weddingB>/hero` and read a private photo out of a wedding they have no role on — an object-reference hole, not a validation nicety. Both `POST /registry/items` and `PATCH /registry/items/:itemId` compare the key's wedding segment against the route's `:weddingId` and answer **400 `image_key_not_in_wedding`** otherwise. The schema separately pins the key's _shape_ — `assets/<segment>/registry-<name>`, no dots, no traversal — so a malformed key 400s before the ownership check ever runs; the two guards answer different questions and both are wanted.

**The shape check also pins the `registry-` prefix, which is what keeps the wedding's own invite photos out of reach.** Without it, an editor could point a registry item at `assets/<thisWedding>/hero-<uuid>` — their own wedding, so the ownership check passes — and the item would serve the invite's hero through the registry route, which sits behind a different gate and answers `private` rather than the invite route's public cache. Worse, deleting the item would reap the hero out of R2. Only keys minted by `storeAsset` for a registry save carry the prefix, so the schema, `imageKeyBelongsTo` and the reap all agree on which objects this module owns. The pattern is defined **once**, beside the minting function in `services/invite-assets.ts` (`REGISTRY_IMAGE_NAME` / `REGISTRY_IMAGE_KEY`), and imported by the schema and the service — three hand-copied regexes were the first version and would have drifted.

---

## Link preview

`POST /api/organiser/weddings/:weddingId/registry/link-preview` takes `{ url }` and answers `{ title, siteName, images: string[] }` — up to six candidate image URLs for the item picker. The organiser pastes a shop link; we fetch the page, read its tags, and hand back what they can choose from.

**This is the most dangerous module in `cire/api`, and the only one of its kind.** Every other outbound fetch we make goes to a host _we_ chose — the OSN issuer, Resend, Stripe, Pinterest. This one goes wherever a caller's URL points, which is the textbook definition of a server-side request forgery sink: the Worker sits in a network position the caller does not have, so "fetch this for me" is a request to borrow it. [`pinterest-resolve.ts`](../../cire/api/src/services/pinterest-resolve.ts)'s answer is a host **allowlist**, which is correct when there is exactly one destination and impossible when the destination is any shop on the internet. So the guard has a different shape.

### Five layers

Implemented in `cire/api/src/services/link-preview.ts`. All must pass, and the first three re-run on **every redirect hop**:

1. **Scheme.** `https:` only. `http:`, `data:`, `file:`, `javascript:`, `ftp:` — refused before a socket exists. Embedded credentials refused too, same reasoning as `external_url` above. Checked twice: once at the HTTP boundary by reusing the `HttpsUrl` schema, and again inside the service, because a `Location` header never passes through a schema.
2. **Destination address.** A literal-IP host is range-checked arithmetically with **no DNS round trip**. A named host is resolved over DNS-over-HTTPS (`cloudflare-dns.com/dns-query`, A + AAAA) and every answer is range-checked; **any** non-public answer rejects the whole URL, and a name that resolves to nothing is rejected too. Blocked ranges: `0.0.0.0/8`, `10/8`, `127/8`, `100.64/10` (CGNAT), `169.254/16` (cloud metadata), `172.16/12`, `192.168/16`, `224/4` and above, `::1`, `fc00::/7`, `fe80::/10`, `ff00::/8`. IPv4-mapped (`::ffff:a.b.c.d`), IPv4-compatible and NAT64 (`64:ff9b::/96`) addresses are **unwrapped and re-checked against the v4 rules** — otherwise every private range above is reachable by spelling it in IPv6. An address we cannot parse counts as blocked; the v4 parser is strict about leading zeros (`0177.0.0.1` is octal loopback to some resolvers and decimal to others — a parser differential).
3. **Manual redirects.** `redirect: "manual"`, capped at 3 hops, layers 1 and 2 re-run on each hop's `Location` **before** the next fetch. Without this a benign first host can 302 us to `http://169.254.169.254/` and the platform's own redirect follower goes happily. Falling out of the cap is `too_many_redirects`, not a loop.
4. **Caps.** One `AbortSignal.timeout` budget (5s) across _all_ hops — three hosts each answering just inside a per-hop timeout must not add up to 15s of a Worker's wall clock. A 512 KB body cap read **off the stream**, cancelling the reader past it, because `Content-Length` is a claim by the same server that would lie about it. `Content-Type` must start with `text/html`.
5. **The candidates we emit.** Absolute-ised against the **final** document URL (not the input URL — a shortener's redirect changes what a relative `src` means), `https:` only, each image host run through layer 2 as well. We do not fetch those URLs, the organiser's browser does — but a `javascript:` or `data:` src must never reach a picker that will put it in an `<img>`.

### The known gap

**The DoH check is TOCTOU-imperfect and cannot be made otherwise on this runtime.** We resolve the name, decide, then hand the **name** to `fetch`, which resolves it again; an attacker who controls the zone can answer differently the second time. Closing that needs a connect-time hook — resolve once, connect to the address we vetted — and workerd exposes none: no socket API under `fetch`, no `lookup` callback, no "pin this address" option. This stops every static private-IP target, every redirect into one, and every host that simply resolves inward. It does not stop a DNS-rebinding attacker. Tracked as **S-M1** in `wiki/todo/security.md`.

### Rate limit

Its own per-organiser limiter, **10 requests a minute**, keyed on `osnProfileId` — not the limiter the registry writes use. One authenticated request costs a full page fetch to a host the caller named, so it is an amplifier, and an Elysia guard applies to every route in its group. That is why it is a third route factory (`createRegistryLinkPreviewRoutes`) rather than another handler on the write group; same split, same reason, as `routes/organiser-enquiries.ts`. Gate order is the write routes' order with the limiter appended: `osnAuth` (401) → `weddingEditor` (403) → `weddingEntitlement` (402) → limiter (429). The limiter is **last** so a wedding without the entitlement is turned away before it can spend anyone's budget.

### Parsing

A commented regex scan, not `HTMLRewriter`. workerd has `HTMLRewriter`; Bun, where the tests run, does not — and a parser that only runs in production is a parser nothing tests. The scan reads `<meta>`, `<link rel="image_src">`, `<img>` and `<title>` only, executes nothing, and its output is untrusted text: a hostile page can at worst make us emit a URL, which layer 5 then re-checks. Ranking is `og:image`/`twitter:image` first, then `image_src`, then `<img>` in document order with anything declaring itself under 100px dropped (icons, sprites, trackers). No new dependency.

**Every pattern in the scan excludes `<` and `>` inside the tag it matches.** A tag regex written the obvious way — `<meta\s[^>]*>` with a nested quoted-attribute alternation, or `<title.*?>` — backtracks quadratically on input that opens thousands of tags and closes none, which is a single 512 KB request away and would burn the whole 10ms CPU budget on a free-tier Worker. The exclusions make each match linear and self-terminating: the scan cannot run past the next `<`. The cost is that an attribute value containing a literal `<` ends the match early, which loses that one tag; the page is a stranger's HTML and the output is six candidate URLs, so losing a malformed tag is not a loss worth a backtracking hazard. Tests flood the scanner with each of the three shapes at the cap and assert wall-clock, so a "tidier" regex cannot quietly reintroduce it.

**Rank-2 (`<img>`) collection stops at 32 candidates**, since only six are ever emitted and a catalogue page carries hundreds. Ordering is untouched by the cap — the sort is stable and the emit loop is unchanged.

**Distinct candidate hosts are resolved at the same time, not one after another.** Layer 5 re-checks every emitted URL, so a page listing six images on six CDNs used to cost six sequential DoH round-trips inside the same 5s budget the page fetch already spent from. The hosts are deduped against the guard's memo, checked with one `Promise.all`, and only then does the ranked list get walked in its original order — the walk reads the memo, so what it emits and in what order is exactly what it emitted before. **Redirect hops stay sequential**: hop _n+1_ is not known until hop _n_ answers, and each one must be vetted before it is followed. The DoH lookups also carry the operation's own signal (`AbortSignal.any([signal, AbortSignal.timeout(2000)])`), so a lookup started near the end of the budget is cancelled with everything else rather than running past it.

### Errors

Tagged classes, mapped by the route. None is a 500 — every failure here is the caller's or the internet's problem:

| Error                        | Status | Code                       |
| ---------------------------- | ------ | -------------------------- |
| `LinkPreviewBlocked`         | 400    | `blocked_url`              |
| `LinkPreviewFetchFailed`     | 502    | `preview_fetch_failed`     |
| `LinkPreviewUnusableContent` | 415    | `unsupported_content_type` |
| `LinkPreviewNoImages`        | 422    | `no_images_found`          |

**`blocked_url` deliberately carries no reason.** It tells the organiser to check their link; telling them _which_ rule fired would turn this endpoint into a network scanner with a clean oracle — `private_address` vs `unresolvable` maps internal ranges one query at a time. The reason goes to the log instead, where only we can read it: `private_address` at ERROR (someone pointed us inward), everything else at WARNING. Log annotations are bounded strings only — never the URL, never the resolved address, never anything the organiser typed.

`counter cire.registry.link_preview` carries one attribute, `result` ∈ `ok | blocked | fetch_failed | unusable_content | no_images`.

Both seams — `fetchImpl` and `resolveHost` — are injectable, so `services/link-preview.test.ts` and the route tests touch no network at all.

### Picking one: we copy the bytes, we never store the URL

Preview hands back candidate URLs. The moment an organiser picks one, `POST /api/organiser/weddings/:weddingId/registry/image/from-url` **downloads it and writes our own copy to R2**, and the item stores that R2 key. The shop's URL is not stored anywhere — not on the item, not in a column, not in the response.

That is a deliberate refusal, and the reasons are ordered by how badly each one bites:

- **The bytes can change after the organiser approved them.** They saw a stand mixer; the shop can serve anything at that URL a month later, on a page couples send to everyone they know. Nothing about the preview binds what was shown to what is served.
- **It rots.** Retailer CDNs re-slug on every catalogue change, and a delisted product takes its image with it. A wedding page is read for months after it is built.
- **It leaks the guest.** Every guest loading the list would make a request to the shop carrying their IP and our referrer — a third-party disclosure nobody consented to, and a vendor entry we would owe the [[cire-consent]] registry.
- **We vetted the host for its IP range and nothing else.** That is enough to refuse an SSRF target; it is not a claim that the host is trustworthy for the lifetime of the page.

Two endpoints, both on the write group's gates (`osnAuth` 401 → `weddingEditor` 403 → `weddingEntitlement` 402) with their own 10-a-minute per-organiser limiter appended (`defaultRegistryImageLimiter` — a save costs an outbound fetch and an R2 write):

| Route                              | Body            | Answers                                           |
| ---------------------------------- | --------------- | ------------------------------------------------- |
| `POST .../registry/image`          | raw image bytes | `{ imageKey, imageUrl, contentType, byteLength }` |
| `POST .../registry/image/from-url` | `{ url }`       | the same                                          |

`services/registry-image.ts` is what both call, and it treats the URL in that body as **fully untrusted even though we emitted it** — the request body is client-controlled, so a client can post any URL to this endpoint, and the emitted candidate has no standing at all. It reuses `link-preview.ts`'s guard — `createUrlGuard` + `checkUrl` + `guardedFetch` + `readCappedBytes`, the same functions the preview path runs — not a second copy of it: same scheme rule, same DoH range check, same manual redirects, same 5s budget. Then, on the bytes:

1. `Content-Length`, if present, over 5 MB → refused before reading. A claim by the sender, so it is a shortcut, never the check.
2. The **real** read length over 5 MB → refused mid-stream, reader cancelled.
3. `detectImageType` on the leading bytes. **The `Content-Type` header is not consulted for the decision** — a server that answers `image/png` over an HTML page is the ordinary case here, not an exotic one, and the stored object's type is the sniffed one. Anything outside `image/jpeg`, `image/png`, `image/webp` is refused.
4. `storeAsset` writes `assets/<weddingId>/registry-<uuid>` — the same pipeline, key shape and bucket as invite hero images, so `imageKeyBelongsTo` and the reconciler already understand it.

Serving is the existing gated route, `GET .../registry/image/:name`, through the Cloudflare Images transform binding: the key is **rebuilt server-side** from the route's `:weddingId` (the client's `:name` is charset-pinned and never a path), the cache version comes from `versionFromKey`, not the client's `?v=`, and the response is `private` — unlike the public invite image route, because this one sits behind an organiser session. That is why the portal's thumbnail goes through `authFetch` into an object URL rather than a bare `<img src>`, and why it asks for `?variant=thumb` (320px) rather than the 800px `card` default — the field paints it at 80px.

The transform caches through the Cloudflare Cache API under a synthetic key. A `private` response is not something the platform cache is obliged to store, so the copy handed to `cache.put` carries `public, max-age=31536000, immutable` and the copy returned to the browser is re-stamped with the route's own visibility on both the miss and the hit path — the synthetic key is unreachable from outside and the lookup happens after the gates, so `public` on the stored copy never reaches a client. This is unverified against a live Worker; see the open **P-W2** in `wiki/todo/perf.md`.

Errors: `blocked_url` 400 (same opaque code, same no-reason rule as preview), `image_fetch_failed` 502, `unsupported_image_type` 415, `image_too_large` 413.

**Nothing leaks on delete, and nothing is reaped out from under a second item.** Two items can hold the same key — an organiser duplicating a row, or two saves of the same picked picture — so the delete counts the remaining holders of that key **in the same step as the delete**, and only reaps when the count is zero. Counting later would race the next delete. The reap itself runs after the response, through `getWaitUntil(request)`, because R2 latency is not something the organiser should wait on; outside a Worker (unit tests, the Bun local entry) there is no `waitUntil`, so it falls back to an inline await and behaves identically, just slower. `asset-reconcile.ts` counts `registry_items.image_key` as a live reference, so a picture saved into an add form the organiser then abandoned — the form has no item id to hang it off, so the save happens first — is swept once it is past the grace window instead of sitting in the bucket forever.

This is what closed **S-L2** in `wiki/todo/security.md`.

---

## Organiser surface (`@cire/host`)

The module lives at `cire/host/src/components/RegistryView.tsx`, wired into the rail by `lib/module-nav.ts`, into the route grammar by `lib/dashboard-route.ts` (`MODULE_SUBS.registry = ["list", "gifts", "settings"]`) and into the shell by `components/ModuleShell.tsx`. Three sub-tabs, two components: `list` and `gifts` mount the **same** `RegistryView` with a `view` prop — one fetch, one cache, two renders — and `settings` is `RegistrySettingsView`, a second chunk reading the same cached snapshot.

**The upsell is the normal state.** The shell wraps the module in `<Show when={entitlements.includes("registry")} fallback={<UpsellPanel feature="registry" />}>`, exactly as vendors does. No wedding holds the entitlement, so an organiser navigating to Registry today sees the panel, and the module below it is code nobody can reach without a comp grant.

**No Overview card.** The obvious "gifts received" tile would fire a guaranteed-402 request on the most-loaded page in the portal, for every wedding, forever, to render nothing. It lands with the entitlement, not before.

**`lib/registry-store.ts`** is the vendors snapshot cache in the same shape: one `GET /registry` per wedding, an inflight map so two mounts share a request, and `invalidateRegistry` on any write. Writes mutate the cached snapshot rather than refetching, which is what makes the reorder and the thank-you toggle feel instant.

**Reorder is buttons, not drag.** ↑/↓ per row, optimistic splice, then `PATCH .../items/reorder` with the full `orderedIds`. A gift list only a mouse can reorder is not one everyone can reorder — which used to make drag expensive here, because the old library supplied no keyboard path. `@shared/sortable`'s `createSortableList` now does (see [[drag-and-drop]]), so adopting drag is a UX decision rather than an accessibility project. Note REG-P-W1 if you take it on: reordering must rewrite only the rows whose position changed, or all up-to-500 rows tear down and an open inline editor loses its caret.

**Money in the UI.** Prices are authored in `weddings.currency` and parsed by `parseMinor` (`lib/money.ts`), which rounds to the currency's own exponent; `minorToInput` is its inverse for seeding the edit form. Both price inputs use `step="any"` deliberately — `step="0.01"` makes a valid three-decimal KWD price a constraint violation the browser refuses before any handler runs. A foreign-currency gift renders **as given** as the headline with the snapshotted primary equivalent underneath, and `contributionsPrimaryMinor` is labelled approximate on screen, because it is a sum of per-day rates and reading it as an exact balance is the mistake worth pre-empting.

**S-L3 — the gift log renders three guest-authored fields.** `note`, `displayName` and the household's `familyName` all come from people we do not control, and all three go through Solid's `{expr}` interpolation and nothing else: no `innerHTML`, no markdown renderer, no rich text anywhere on this path. If a future PR wants formatted notes, it needs a sanitiser and a review, not a renderer. Pinned by `renders a script-shaped note, display name and family name as literal text (S-L3)` in `RegistryView.test.tsx`, which asserts the payload appears as text _and_ that no `script`, `img` or `b` element exists in the container.

**The picture field** is `components/RegistryImageField.tsx`, mounted in both the add form and the inline editor, and it matches `invite/ImageField.tsx` in structure, error surface and accessibility handling. Two divergences, both forced: the thumbnail is `authFetch`ed into an object URL (the registry serve route is gated and `private`, so a bare `src` would 401), and the link path offers a **choice** rather than taking the first candidate — a radio group with roving tabindex, arrow/Home/End keys, and an accessible name built from the page's own title rather than "image 1". `ImageCropModal` is deliberately **not** reused: it is slot-typed to the invite's `CropSlot`s and reads `CROP_ASPECT[slot]`, and registry items have no crop slot.

Candidates are filtered to `https:` **again in the browser** before any of them becomes an `<img src>`, and the pick is re-checked before it is posted. The API emits nothing else, but a render site that trusts its input because of what the server promised is one API change away from being wrong. "No pictures on that page" (422) is a normal outcome, not an error: it renders as a note that offers the upload path, not an alert.

**The gift log says what a status means, not what the column holds.** `giftStatus()` in `RegistryView.tsx` maps the row to a word the couple would use — a claim reads Promised / Bought / No longer coming, a contribution reads Not cleared yet / Received / Refunded / Payment disputed — because the two tables share the column and share none of its values, and nobody should meet "succeeded" in their own gift log. Refunded and released carry the error tint, and a refunded gift gets a sentence under it: it went back, and it is not in the total above. A status this build has no word for is rendered as it arrived rather than swallowed.

---

### The settings tab (`@cire/host`)

`RegistrySettingsView` is the registry module's third sub-tab, beside the gift list and the gifts received. It holds the four decisions the guest surface had been reading with nowhere to make them — publish, copy, shipping address (and its embargo date), money gifts — plus Stripe onboarding.

**One snapshot, shared with the list.** It reads the same cached `RegistrySnapshot`, so moving between sub-tabs costs no fetch, and a save patches the settings row in place rather than invalidating the whole thing.

**Two roles, one visible line.** The tab is `edit`-gated, so a read-only viewer never reaches it; everything on it is `weddingEditor` at the API **except** connecting the Stripe account, which is `weddingOwner`. An editor still sees that panel, with the reason — a co-host who wonders why money gifts are off gets an answer rather than a missing section. The Connect button is `aria-disabled`, not `disabled`, and that is the point: a `disabled` button leaves the tab order and a screen reader in forms mode skips it, taking the explanation out of reach of exactly the person asking for it. It stays focusable, `connectStripe()` refuses on `canManage`, and the owner-only route refuses behind that (C-L2).

**The panel does not probe for Stripe, and never has (C-L1).** With no `STRIPE_SECRET_KEY` the API's Connect routes are not mounted at all, and nothing in `@cire/host` reads a capability flag to find that out — the Money-gifts section renders on every tier, and a keyless deployment (which is every tier today, pending the paperwork in [[subprocessors]]) learns the truth from the 404 the Connect button raises as a toast. That is survivable but not the account-linking shape, where a flag hides the surface. If hiding it becomes worth doing, it needs a capability field on `GET /registry` and a `Show` around the section; until then, do not write that the portal hides it.

**Publishing is blocked while the list is empty**, and the notice says why: guests reach the list _and the money-gift option with it_ only once it is published, so an empty published list is a page with nothing on it. An already-published list keeps the toggle live, or deleting the last gift would freeze a couple on "Published" with no way back.

**Intent and capability are two controls.** "Let guests give money" is disabled until `stripe_charges_enabled`; the API refuses the write anyway (`stripe_not_ready` → 409), and the panel answers that 409 by saying Stripe cannot take a payment yet rather than "check the fields".

**One live Stripe read, for one state.** On mount, a wedding that has an account but cannot yet charge calls `…/stripe/refresh` once — they have just come back from onboarding and `account.updated` can be seconds behind them. A couple with no account, or one already ready, costs nothing. "Check again" is the same call, pressed by hand, and it reports "still not ready" too.

---

## Guest surface (`@cire/invites`)

**The list has its own page: `/<slug>/registry`.** It used to be the last section of the invite. It is the one part of an invitation a guest comes _back_ to — to see what is left, to change what they reserved, to open it in a shop — and none of that should mean scrolling the invitation again. It is also a link a couple can send on its own.

`src/lib/gift-registry.ts` is the client; `src/components/gift-registry/` is the UI:

| File                         | What it is                                                    |
| ---------------------------- | ------------------------------------------------------------- |
| `GiftRegistryDocument.astro` | The page shell: masthead, sticky return rail, footer, consent |
| `GiftRegistryPage.tsx`       | The page body — both reads, every write, the shelves          |
| `GiftRegistryItemCard.tsx`   | One gift, with its own claim form                             |
| `GiftRegistryTeaser.tsx`     | The band left behind on the invite, linking to the page       |

`src/pages/[slug]/registry.astro` is the route, and it makes **one** read: the invite, which is public, so the couple's copy, colours and hero photo are server-rendered and the page paints as theirs immediately. The LIST cannot be server-rendered at all — `cire_session` is host-scoped to the API origin, so the browser never sends it to the guest Worker and there is no household for the server to be. The island makes that read. Both design packs mount the _teaser_ from `Document.astro` as a `client:visible={{ rootMargin: "600px" }}` island between `<InvitePage>` and `<SiteFooter>`, where the section used to sit.

**One shell, not one per design pack.** The packs differ in the invite's own structure; the gift list never has — it was one shared component in both, and its surface comes from the same derived palette, fonts and section tone every other section reads. If a pack ever forks the gift surfaces, the shell takes the pack as a prop rather than being duplicated.

**The only 404 the route answers is an unknown wedding.** It cannot tell a missing list from a locked one without becoming an oracle for exactly what the API's single 404 code exists to hide: a page that 404s for "no registry" answers, to anyone holding a slug, a question the API refuses. A failed *invite* read still renders the page, with the built-in theme and copy — the list is what the page is for. Pinned by `cire/invites/tests/pages/[slug]/registry.test.ts`, a source-text guard in the shape of `tests/pages/index.test.ts`. Both live outside `src/pages` entirely, which is what keeps them out of Astro's router — a test file under `src/pages` is a live route and drags vitest into the SSR bundle (tracker #287). They were briefly `_`-prefixed in place for the same reason; the `tests/` move supersedes that.

**Four states, and the island decides which.** Its first job is the credentialed list read, so `client:load`, not `client:visible` — waiting for the viewport would mean waiting to find out whether the guest is allowed in at all.

| The read says                            | The page shows                                                                                                                          |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| nothing yet                              | "Opening the couple's list…", a live region — the read cannot start until hydration                                                     |
| `401`                                    | `[data-gift-locked]`: "This gift list is for the couple's guests", and a button to the invitation. Not an error; nothing has gone wrong |
| `404`                                    | "The couple have closed their gift list", and the way back                                                                              |
| a transport failure, as the FIRST answer | "Could not reach the gift list"                                                                                                         |
| `200`                                    | the intro, the ledger, the shelves                                                                                                      |

A transport failure that is _not_ the first answer changes nothing at all: a list already on screen stays. `registry` holds the last list the server sent, `outcome` the last real answer, and the two are separate for exactly this.

**It is still its own island.** `InvitePage`'s body is gated on a claim and reveals in place, so neither the band nor the page may live inside it — but both now read the same gate it does, and both listen for `CLAIM_SESSION_EVENT`: a guest who enters their code sees the band appear on the invitation without a reload, and a locked gift page opens in the same tab the moment the session lands.

**The band is gone for a visitor who has not claimed.** No teaser, no link, no mention — the same silence every other claim-gated section keeps, rather than advertising a page that would only turn them away.

**Counts, never names.** The card renders `giftRegistryRemainingCopy` ("1 of 2 left", "All reserved") and, for a taken item, "Another guest has this one covered." The only name on the page is this household's own `displayName`, read from the credentialed `…/registry/mine` route and echoed back to the people who typed it. Notes are never rendered at all — they are addressed to the couple. Pinned by tests in both component files that assert no `reserved by`-shaped text and no claimant identity in the DOM.

**No optimistic update anywhere, on purpose.** Every count a guest reads came from a read the server had just answered. A claim that returns 409 `item_fully_claimed` refetches **both** reads, then says: _"Another guest reserved the last "X" a moment ago. The list below is up to date."_ — and leaves the guest's form open with what they typed still in it. `applyOutcome` is the single place that decides what a write means: `ok` / `fully-claimed` / `item-gone` re-read both, `hidden` re-reads the list (which then 404s, and the page says the couple have closed their list, with a link back to the invitation), `signed-out` drops to the signed-out surface, and rate-limited / invalid / transport errors re-read nothing because nothing moved.

**The list is keyed by id, not by item — and the shelves by category string.** `<For>` reconciles by reference and every refetch parses fresh objects, so iterating the items would dispose and re-create every row on each re-read — throwing away the open claim form at precisely the moment the 409 path re-reads in order to show the new counts _beside_ the words the guest just wrote. Rows iterate ids and look the item up in `itemsById()`; shelves iterate `groupKeys()` (the category string, `null` for the unlabelled tail — both primitives that compare equal) and look the group up in `groupsByKey()`. Keying the shelves on the rebuilt group objects would take every open form under them down with the shelf.

**Shelves are the couple's own categories.** `groupGiftRegistryItems` keeps them in the order the list already carries (first mention wins — nothing is alphabetised behind their back), trims them so one spelling is one shelf, and puts everything ungrouped in one tail last, under "More gifts". When they grouped nothing, `hasGiftRegistryCategories` is false and no label is painted at all: one unlabelled shelf is a plain list, and heading it would name a distinction they never made.

**The ledger line** above the list is what a page can say that a section could not: `giftRegistryAvailabilityCopy` ("6 of 14 still available", "Every gift has been reserved") on the left, and this household's own `giftRegistryClaimedCopy` ("You reserved 2 gifts") on the right when it has any. Counts only, same rule as the cards, and quantities rather than rows — one row for six glasses is six gifts to a guest. An empty list gets its own copy instead, never "0 of 0".

**The reserve ceiling is not `remaining`.** The server's claim is an upsert whose availability guard excludes the caller's own row, so a household may raise its own reservation to `remaining + ownClaim.quantity` (capped at 99). A household holding both of two copies still sees a Change control, not a dead card.

**`external_url` is re-checked at the render site.** `giftRegistryExternalHref` re-parses the column and returns `null` for anything that is not `https:` (and for embedded credentials), so a non-https value renders no link at all rather than an `<a href>`; the link carries `target="_blank" rel="noopener noreferrer"`. Same reasoning as **CON-S-L2** and as the organiser-side re-filter: a render site that trusts its input because of what the server promised is one API change away from being wrong.

**Reads.** Both reads are credentialed and `no-store`. The household read passes `credentials: "include"` — the guest cookie is host-scoped to the API origin, which is a different origin from the guest site, and a cross-origin fetch on the default `same-origin` mode drops it silently. It is also gated on the `cire_claimed` hint cookie (`hasClaimedHint`, exported from `claim-session.ts`): both surfaces are public and shareable, so an unconditional `…/registry/mine` would spend a guaranteed 401 **per page view** rather than per guest, against an account-wide Workers Free budget.

**A failed re-read leaves what is on screen.** Only an answer replaces what is rendered: `ok` swaps the list, `401` locks it, `404` closes it, and a transport failure changes nothing. As a band at the foot of the invite, blanking on a blip cost a section nobody had scrolled to; on a page it would blank the page under someone reading it.

**States that look alike and are not.** An unpublished or unentitled registry 404s: the page says the couple have closed their list and the band renders nothing at all on the invite. A visitor with no claim gets a 401, which is a different page again — a way in, not a refusal. A published empty list renders its masthead and "The couple haven't added any gifts yet." The shipping address renders only when the household read actually returned one — the field is optional on the wire and carries no reason, so absent covers both "the couple set none" and "you may not see it", and there is nothing honest to print in its place.

**Copy and theme.** `registry_*` copy columns reach both surfaces as `eyebrow` / `heading` / `body`; `null` means the built-in default (`With Love` / `Gift Registry`), the same contract as the details section. Where both exist, the invite's own section copy wins over the registry module's `headline` / `message`, because it is section furniture themed with every other header. Resolution is pure (`giftRegistryEyebrow` / `giftRegistryHeading` / `giftRegistryBody`) so the Astro shell can render the masthead server-side, and **blank counts as unset** — the old `??` chain let a heading saved as `""` beat both fallbacks, which on a page of its own is an empty browser tab. `ThemeSection` carries `"registry"`, so both surfaces take a tone through the same `sectionVars` allow-list as the rest, and the page's masthead reuses the invite hero's own server-blurred `hero-bg` variant at the same URL — already in cache for a guest who came from the invitation — with the organiser's crop honoured through `heroCropLayers`.

**Where each half of that copy renders.** The masthead's eyebrow and heading come from the invite payload, which is public, so they are server-rendered; the module's own `headline` / `message` arrive with the gated list, so the **intro paragraph** is the island's and carries the whole chain (invite body, then module message). One paragraph, one place, and neither surface waits on the other.

**The way back stays put.** The rail is `position: sticky` with its own `Z_LAYER.STICKY_RAIL` (20): every card below it paints a background and sits later in the document, so without a layer the rail is painted over by the list the moment it starts to matter.

**Status is a live region at the page root**, never an overlay: this section sits among animated ones and any ancestor `transform` traps `position: fixed`. The claim form is inline in the card for the same reason.

**`kind: "cash_fund"` is not special-cased.** It renders like any other item. Contributions land with Stripe Connect; a contribute flow over a backend that cannot take a charge would be UI standing in for something that does not exist.

**Not built here:** contributions, and any surface for a claim's `status` beyond `reserved`.

---

## Observability

`cire.registry.item.write` (attribute: `action` = create/update/remove) and `cire.registry.gift` (attribute: `action` = thanked/unthanked). Both are attributed by action only — no `weddingId`, `itemId` or `familyId` ever reaches a metric attribute; those belong in spans and logs.

Every handler runs `Effect.tapDefect` before its catch-all, so a defect is **logged** (`registry handler defect`, annotated with `weddingId` alone) instead of being swallowed into a bare 500. `weddingId` alone is the point: a guest's note, display name or contribution message is PII and never reaches a log line, so the annotation is deliberately the one field that identifies the wedding and nothing that identifies a person.

---

## Naming hazard

`cire/invites/src/designs/registry.ts` is the **invite design-pack registry** — an unrelated use of the word that predates this module. Guest-site files for this feature use `gift-registry` to keep the two apart.

---

## Still to land

- **The FX capture**: `checkout.session.completed` carries no balance transaction, so the four FX columns are still NULL. The `exchange_rate` read described under [Money](#money) needs its own event or a follow-up call
