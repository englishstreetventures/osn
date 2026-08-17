---
title: "Gift registry"
tags: [system, registry, gifts, money, phase-4]
related:
  - "[[entitlements]]"
  - "[[budget]]"
  - "[[platform-plan]]"
  - "[[consent]]"
  - "[[drag-and-drop]]"
last-reviewed: 2026-08-14
---

# Gift registry

Phase 4 module. The couple curate a gift list; guest **households** claim from it so nobody buys the same thing twice; the couple work from a gift log afterwards to write thank-yous. Card contributions ride Stripe Connect and land in a later PR — everything below is usable as an honour-system list with no Stripe account at all.

> **It is locked.** The `registry` entitlement is granted to no wedding, so every route in this page answers `402 payment_required` in production today. See [[entitlements]] for the mechanism and the comp-grant CLI. Nothing here is reachable until someone grants it.

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

| Column | Notes |
|---|---|
| `published` | Guest visibility. The guest read requires this **and** the entitlement — two independent gates, so an entitlement lapsing can't silently republish a registry the couple turned off, and vice versa |
| `headline`, `message` | The couple's copy above the list ("no boxed gifts please"). NULL ⇒ nothing renders |
| `cash_gifts_enabled` | Off by default and independently of `published` |
| `shipping_address`, `shipping_visible_from` | Shown to claimed guests only; the date is the "don't ship until we're back" pattern |
| `stripe_account_id`, `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_account_updated_at` | Connect state, cached from the `account.updated` webhook so the portal needs no live Stripe call per page load |

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

**The wedding has one primary currency** — `weddings.currency`, already shared with [[budget]]. The registry reuses it and introduces no second source of truth.

- **Everything the organiser authors is in the primary currency.** `registry_items.price_minor` has no currency column of its own. A gift list quoted in four currencies is unreadable, and a per-item currency is the change that makes it one.
- **Only received money can be foreign.** A contribution stores `amount_minor` + `currency` **as given**, plus `primary_amount_minor` + `primary_currency` + `fx_rate` + `fx_rate_at` — the primary-currency equivalent. All four are NULL when the gift arrived in the primary currency, which is the common case, and the UI then shows a single figure.
- **The host reads the as-given amount as the primary visual, with the primary-currency line underneath.** Never a silently converted single figure.
- **Rates are snapshotted per gift and never recomputed.** A gift log that re-values itself whenever rates move is not a record of anything.

The rate comes from **Stripe's balance transaction** (`exchange_rate`), not a third-party FX feed: it is authoritative, free, arrives with a webhook already being handled, and matches what actually reached the couple's bank. No new subprocessor and no scheduled rate fetch. When no balance transaction is available yet the FX columns stay NULL and the figure renders alone — the degraded state is the common state, which is the right way round.

**Totals** sum `primary_amount_minor` only (falling back to `amount_minor` where the currencies already match) and must be labelled approximate: each row was converted at its own snapshotted rate, so the sum is of historical conversions, not a live valuation.

Rendering goes through `formatMinorPair` in `cire/host/src/lib/money.ts`. That module also knows each currency's **real minor-unit exponent** — JPY has none (1000 minor units is ¥1000, not ¥10) and KWD/BHD/JOD use three. The old fixed `/ 100` was invisible while every wedding was in AUD and is wrong by 100× the moment a gift arrives in yen.

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

- **`rc.family_id <> ?` excludes the caller's own row**, so a household raising its own quantity is measured against *other* households' claims. That is what lets one statement serve both the first claim and a later change, via the `ON CONFLICT` arm.
- **Success is decided by `RETURNING`**, never by re-reading the `(item_id, family_id)` pair. A household that had *released* this item still has a row there, so the re-read would report success for a claim the guard refused. There is a test named for exactly this.

Zero rows returned means one of two things; only that failure path pays for a second query to tell `ItemFullyClaimed` (409) from `RegistryItemNotInWedding` (404).

**Timestamps.** This statement writes `created_at` / `updated_at` directly rather than through a Date-valued insert, so it must match drizzle's `integer({ mode: "timestamp" })` unit — **epoch seconds, not milliseconds**. Getting it wrong still writes the row, just dated to the year 58000, so `toEpochSeconds` is pinned by a test against what a normal drizzle insert produces.

---

## API

All organiser routes sit under `/api/organiser/weddings/:weddingId/registry`, gated `osnAuth()` → role gate → **`weddingEntitlement(db, "registry")`** → rate limiter. Ordering matters: a stranger gets 403 from the role gate *before* the entitlement gate runs, so a 402 never leaks which weddings exist or which features they hold.

| Route | Gate |
|---|---|
| `GET /registry` — settings + items (with claim counts) + gift log | `weddingMember` |
| `PUT /registry/settings` | `weddingEditor` |
| `POST /registry/items`, `PATCH /registry/items/reorder`, `PATCH \| DELETE /registry/items/:itemId` | `weddingEditor` |
| `POST /registry/gifts/:kind/:giftId/thanked` | `weddingEditor` |

`/registry/items/reorder` is registered **before** `/registry/items/:itemId` so the literal wins over the param. `:kind` is decoded through the same Effect Schema a body field would be — an unknown value 400s rather than falling through to a table by coincidence.

### Bounded reads

`GET /registry` returns the settings, every item, and a **page** of the gift log — never the whole log. A wedding with 300 guests can produce a four-figure gift log, and one unbounded read of it on every portal page load is the shape that turns a free-tier D1 read budget into an outage.

- **50 gifts a page** (`GIFT_LOG_PAGE`), with `?giftsOffset=` walking it and **`giftsHasMore`** in the response telling the portal whether to draw a "load more". An unparseable, negative or absurd offset reads as 0 rather than 400ing — a junk query string is a broken link, not an attack worth a status code.
- **The offset is capped** (`MAX_GIFT_LOG_OFFSET` = 500). Paging is offset-based, not keyset, because the log merges two tables whose timestamps are second-granular and share no id order; a cap is what keeps the cost of the deepest page bounded.
- **Totals are computed in SQL, not from the page.** `contributionsPrimaryMinor` is a `sum()` over every `succeeded` contribution. Summing the page instead would under-report the couple's money the moment the log passed 50 entries — silently, and in the direction that looks like a missing gift.
- **500 items a wedding** (`MAX_ITEMS_PER_WEDDING`) — `POST /registry/items` answers **409 `registry_item_limit_reached`** past it. The ceiling is per wedding, not per account.

`PUT /registry/settings` refuses `cashGiftsEnabled: true` with **409 `stripe_not_ready`** unless the wedding's Connect account can actually take charges. Offering a contribute button that 503s is worse than offering none, because the guest believes they paid.

### External URLs

`external_url` must be an absolute `https:` URL, checked at the boundary by parsing it — not by shape-matching. It reaches an `<a href>` on the guest site, and an unvalidated URL there is a same-origin script sink; the precedent is **CON-S-L2**, where `vendor.privacyUrl` reached an `href` with no scheme check. The guest renderer re-checks rather than trusting the column, because a row can also arrive from a migration or a fixture.

The parse also **rejects embedded credentials** (`https://evil.com@retailer.example/…`, which reads as the retailer to a guest and resolves to `evil.com` to the browser) and **stores the parsed `URL.href`**, not the raw input — so what the column holds is the normalised form the browser would resolve, and two spellings of the same URL can't diverge between the check and the render.

`shipping_visible_from` is a calendar date, and its schema round-trips the string through a real `Date` rather than shape-matching `\d{4}-\d{2}-\d{2}`: `2026-02-30` matches the shape and is not a day.

### Images

Registry images are **always our own copy in R2**, through the existing invite-assets pipeline. Never hotlink a retailer image: an off-origin `img-src` breaks the guest site's CSP and would need a vendor entry in the [[consent]] registry.

**An `imageKey` must name this wedding's own upload.** Keys are `assets/<weddingId>/<name>`, so an editor on wedding A could otherwise set an item's image to `assets/<weddingB>/hero` and read a private photo out of a wedding they have no role on — an object-reference hole, not a validation nicety. Both `POST /registry/items` and `PATCH /registry/items/:itemId` compare the key's wedding segment against the route's `:weddingId` and answer **400 `image_key_not_in_wedding`** otherwise. The schema separately pins the key's *shape* (`assets/<segment>/<segment>`, no dots, no traversal), so a malformed key 400s before the ownership check ever runs — the two guards answer different questions and both are wanted.

---

## Organiser surface (`@cire/host`)

The module lives at `cire/host/src/components/RegistryView.tsx`, wired into the rail by `lib/module-nav.ts`, into the route grammar by `lib/dashboard-route.ts` (`MODULE_SUBS.registry = ["list", "gifts"]`) and into the shell by `components/ModuleShell.tsx`. Both sub-tabs mount the **same** component with a `view` prop — one fetch, one cache, two renders.

**The upsell is the normal state.** The shell wraps the module in `<Show when={entitlements.includes("registry")} fallback={<UpsellPanel feature="registry" />}>`, exactly as vendors does. No wedding holds the entitlement, so an organiser navigating to Registry today sees the panel, and the module below it is code nobody can reach without a comp grant.

**No Overview card.** The obvious "gifts received" tile would fire a guaranteed-402 request on the most-loaded page in the portal, for every wedding, forever, to render nothing. It lands with the entitlement, not before.

**`lib/registry-store.ts`** is the vendors snapshot cache in the same shape: one `GET /registry` per wedding, an inflight map so two mounts share a request, and `invalidateRegistry` on any write. Writes mutate the cached snapshot rather than refetching, which is what makes the reorder and the thank-you toggle feel instant.

**Reorder is buttons, not drag.** ↑/↓ per row, optimistic splice, then `PATCH .../items/reorder` with the full `orderedIds`. See [[drag-and-drop]] — solid-dnd has no keyboard sensor, and a gift list only a mouse can reorder is not one everyone can reorder.

**Money in the UI.** Prices are authored in `weddings.currency` and parsed by `parseMinor` (`lib/money.ts`), which rounds to the currency's own exponent; `minorToInput` is its inverse for seeding the edit form. Both price inputs use `step="any"` deliberately — `step="0.01"` makes a valid three-decimal KWD price a constraint violation the browser refuses before any handler runs. A foreign-currency gift renders **as given** as the headline with the snapshotted primary equivalent underneath, and `contributionsPrimaryMinor` is labelled approximate on screen, because it is a sum of per-day rates and reading it as an exact balance is the mistake worth pre-empting.

**S-L3 — the gift log renders three guest-authored fields.** `note`, `displayName` and the household's `familyName` all come from people we do not control, and all three go through Solid's `{expr}` interpolation and nothing else: no `innerHTML`, no markdown renderer, no rich text anywhere on this path. If a future PR wants formatted notes, it needs a sanitiser and a review, not a renderer. Pinned by `renders a script-shaped note, display name and family name as literal text (S-L3)` in `RegistryView.test.tsx`, which asserts the payload appears as text *and* that no `script`, `img` or `b` element exists in the container.

**Not built yet on this surface:** the settings form (publish toggle, shipping address, cash gifts), and any image field — the editor omits `imageKey` entirely rather than shipping an input with no picker and no serve path behind it.

---

## Observability

`cire.registry.item.write` (attribute: `action` = create/update/remove) and `cire.registry.gift` (attribute: `action` = thanked/unthanked). Both are attributed by action only — no `weddingId`, `itemId` or `familyId` ever reaches a metric attribute; those belong in spans and logs.

Every handler runs `Effect.tapDefect` before its catch-all, so a defect is **logged** (`registry handler defect`, annotated with `weddingId` alone) instead of being swallowed into a bare 500. `weddingId` alone is the point: a guest's note, display name or contribution message is PII and never reaches a log line, so the annotation is deliberately the one field that identifies the wedding and nothing that identifies a person.

---

## Naming hazard

`cire/invites/src/designs/registry.ts` is the **invite design-pack registry** — an unrelated use of the word that predates this module. Guest-site files for this feature use `gift-registry` to keep the two apart.

---

## Still to land

- Link preview + image picker (paste a product URL, choose from extracted images) — its own PR, with the hardened fetcher and its SSRF controls documented there
- Guest surface: the invite section, the claim/release routes, the household read path
- Stripe Connect (Express): onboarding, hosted Checkout, the webhook, and the balance-transaction FX capture described under [Money](#money)
