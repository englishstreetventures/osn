---
title: Cire budget
tags: [system, budget, phase-1, cire]
related:
  - "[[cire-platform-plan]]"
  - "[[cire-checklist-tasks]]"
  - "[[drag-and-drop]]"
  - "[[decisions/deferred-decisions]]"
  - "[[cire-rsvp-deadline]]"
  - "[[cire-host-portal-layout]]"
last-reviewed: 2026-09-27
---
# Budget

Phase 1 Budget v1 module. Organisers add line items under a service category, track estimate → quoted → actual per item, attach payment schedule rows (deposit/balance with due + paid dates), and edit the overall cap from the Budget tab. A line can be priced per head, so its estimate follows the RSVPs (see [[#Per-head lines]]).

## Database Schema

### `budget_items` table (additive migration 0039)

Per-wedding line-item tracker, keyed by category.

- `id` — primary key
- `wedding_id` — foreign key to `weddings`, cascade delete
- `category` — service category string key (e.g., `venue`, `catering`, `photography`)
- `name` — the line's name (free text)
- `estimate_minor` — optional estimate amount (minor currency units, NULL allowed). Always NULL on a per-head line
- `quoted_minor` — optional quoted amount from vendor
- `actual_minor` — optional actual amount paid
- `unit_price_minor` — price per guest (migration 0066). Non-null marks a per-head line
- `per_head_event_ids` — JSON array of the event ids a per-head line counts; NULL means every event (migration 0066). NULL whenever `unit_price_minor` is NULL
- `notes` — free text
- `sort_order` — reorder within category
- `created_at`, `updated_at` — timestamps

Spend rule: `actual ?? quoted ?? estimate ?? 0` (`itemSpend` on client, `computeRollup` on server), where a per-head line's estimate is its computed amount.

### `payments` table (additive migration 0039)

Payment schedule rows (deposit/balance) linked to budget items.

- `id` — primary key
- `budget_item_id` — foreign key to `budget_items`, cascade delete
- `label` — e.g., `deposit`, `balance`
- `amount_minor` — payment amount (minor units)
- `due_date` — ISO date string
- `paid_date` — ISO date string (nullable; NULL means unpaid)
- `created_at`, `updated_at` — timestamps

## Service-Category Enum

**Single source of truth:** `cire/api/src/lib/service-categories.ts` (server definition, closed enum).

**Organiser mirror:** `cire/host/src/lib/service-categories.ts` — read-only enum re-export for UI rendering.

The enum serves four domains:
- Budget (item category grouping + rollup subtotals)
- Checklist (task categorization)
- Vendors (Phase 2: vendor CRM category filter)
- Pricing (Phase 3: heuristic engine category × region baselines)

All four consumers read the same enum key strings — no duplication, no drift.

## Route Surface

`POST/GET/PUT/DELETE /api/organiser/weddings/:weddingId/budget` family (three write gates):

### Member read (any role)
- `GET /api/organiser/weddings/:weddingId/budget` — fetch full snapshot: all items + payments, category rollups (sum per category + total), budgetTotalMinor cap, the wedding's `events` (`{ id, name }` by `sort_order`, for the per-head picker) and `rsvpsClosed`. Each item carries `unitPriceMinor`, `eventIds` and `headcount` (see [[#Per-head lines]])

### Editor writes (owner or `editor` role)
- `POST .../budget/items` — create item (auto-increment sortOrder). Optional `perHead: { unitPriceMinor, eventIds? }` makes it per head
- `PATCH .../budget/items/:itemId` — update name/category/estimate/quoted/actual/notes, and `perHead` (`null` makes the line fixed again)
- `DELETE .../budget/items/:itemId` — remove item (deletes cascade to payments)
- `PATCH .../budget/items/reorder` — `{ category, orderedIds }`: the category's new order, written as `sortOrder` = array index. Registered before `.../items/:itemId` so the literal path wins
- `POST .../budget/items/:itemId/payments` — add payment row
- `PATCH .../budget/items/:itemId/payments/:paymentId` — update payment label/amount/due/paid dates
- `DELETE .../budget/items/:itemId/payments/:paymentId` — remove payment row

### Owner cap gate (owner role only)
- `PUT /api/organiser/weddings/:weddingId/budget/total` — update `weddings.budget_total_minor` (moved from Settings module)

**Tenancy:** `BudgetItemNotInWedding` + `PaymentNotInItem` error tags prevent cross-wedding/cross-item access. `EventNotInWedding` refuses a per-head line naming another wedding's event (400 `unknown_event`).

## Rollup Spend Rule

**Server rule** (`services/budget.ts::computeRollup`, fed `lineEstimate`):
```
estimate = per-head line ? unit price × headcount : estimate_minor
itemSpend = actual ?? quoted ?? estimate ?? 0
categorySpend = sum of itemSpend per category
totalSpend = sum of itemSpend across all items
```

**Client rule** (organiser `lib/budget-store.ts` `lineEstimate` / `itemSpend` + `BudgetView` component):
```
same rule, computed from local state and the snapshot's rsvpsClosed
```

Both sides use the **same precedence** — no disagreement on what "spent" means. Live budget vs cap comparison: `totalSpend` vs `weddings.budget_total_minor`.

## Per-head lines

A line with a `unit_price_minor` is priced per guest. The couple enters the price and can limit the line to some of the wedding's events. The amount is never stored: every read counts the guests from the RSVPs.

**Who counts.** The count runs over invitations (`guest_events`) of the line's events, joined to the guest's reply for that event, if any (`services/budget.ts::countHeads`):

| Figure | A guest counts when |
|---|---|
| Expected | They are invited to at least one of the line's events and have not declined all of those invitations. Attending, maybe and no reply yet all count |
| Confirmed | They replied "attending" to at least one of the line's events |

- A guest invited to several of the line's events counts once. A supplier who charges per guest per event gets one line per event.
- The host preview household and households whose invite was withdrawn (`families.deactivated_at` set) are not counted. The Budget tab's figures can therefore sit below the attending counts on Overview and the RSVP table, which count withdrawn households; the per-head panel says so.
- A reply left on an event the guest is no longer invited to is ignored, because the count starts from `guest_events`.
- A named plus-one is a `guests` row with its inviter's invitations, so it counts like any other guest.
- The count is done in code, not SQL: `status != 'declined'` in SQL is unknown for the NULL of an unanswered invitation and would drop exactly the guests "expected" counts.

**Which figure prices the line.** While RSVPs are open, expected × price; once the wedding's RSVP deadline has passed (`isRsvpClosed`, see [[cire-rsvp-deadline]]), confirmed × price. A wedding with no deadline stays open. The Budget tab shows both figures while RSVPs are open and the confirmed one after. A quote or actual on the line still wins in the spend rule.

**Picked events.** `per_head_event_ids` is a column rather than a join table with a cascading foreign key: deleting the only picked event would empty the set, and an empty set would read as "every event". A stale id matches no invitation, so a line whose picked events were all deleted counts nobody and the Budget tab says so. The item DTO's `eventIds` is `null` for every event and otherwise lists only the picked events that still exist.

**Write rules** (`schemas/budget.ts`, `services/budget.ts`):
- `perHead.eventIds` absent keeps the line's current events; `null` counts every event; a list (1 to 50 ids) counts only those. `[]` is a 400, so an empty list cannot widen a line by accident.
- Making a line per head clears `estimate_minor`. A body carrying both `perHead` and a non-null `estimateMinor` is a 400, and an `estimateMinor` patch on a line that is already per head is dropped in the same UPDATE.
- `perHead: null` makes the line fixed and clears its events. The Budget tab's "Use a fixed amount" sends the line's current computed amount as the new estimate with it.
- The price is capped at 100,000,000,000 minor units, the same ceiling as the budget total, so price × headcount stays a safe integer.

**Cost.** The invitation read (`cire.budget.headcount` span) runs only for a wedding with at least one per-head line; a fixed-only budget reads what it always did plus the event list, all in one concurrent round. A per-head write checks its picked events against the wedding's event list, which it reads anyway for the headcount, and runs the invitation read alongside the INSERT or UPDATE.

**Deploy order.** The organiser portal can deploy before the API. The Budget tab offers per-head controls only when the snapshot carries `events`, because an older API would drop `perHead` from a write and still answer 200.

## Client-Store Fetch-Lift

**`cire/host/src/lib/budget-store.ts`** — the `weddingId`-keyed cache of one wedding's budget snapshot (`GET /api/organiser/weddings/:weddingId/budget`), shared by the Budget view and the Overview's budget widget so the two make one request.

- **Writes** — a successful create or edit folds the row the server returns into the cached snapshot. Only a failed write reads the budget again, to undo the optimistic change.
- **Lifetime** — the same contract as its siblings (`guests-store.ts`, `events-store.ts`, `tasks-store.ts` and the rest): stale-while-revalidate after a write, and every row dropped when the wedding's dashboard closes. See [[cire-host-portal-layout#Organiser client caches: stale-while-revalidate]].
- **Per-head refetch** — a per-head line's figures change as RSVPs arrive, with nobody touching the budget. So the Budget view loads through `revalidateBudget`: when the cached snapshot holds a per-head line it is marked stale and refetched each time the view opens, with the old rows on screen meanwhile; a refused refetch blanks them as any other does. An open while a load is already in flight joins that load rather than discarding it. A budget with no per-head line loads once. The Overview card does not refetch, because its fetcher soft-fails to an empty snapshot that would then be cached; it shows whatever was last loaded. This exception is the budget module's alone, not part of the shared cache contract.
- **Money inputs** — the per-head price reads and writes through `parseMinor` / `minorToInput` in `cire/host/src/lib/money.ts`, which use each currency's real minor-unit exponent.

## Reordering items

Within a category only. Each row has a grip to drag or to move with the arrow keys, plus move-up and move-down buttons for screen readers, all from `@shared/sortable` through `cire/host/src/components/ReorderControls.tsx`; the move is announced in the category's own live region and focus stays on the moved row. A move rewrites only the items whose position changed, so an open payments panel on any other row keeps what was typed in it. See [[drag-and-drop]].

## Cap Moved Out of Settings

Previously: `Budget` v0 (Phase 1 spec artifact) had the cap editor in the Settings tab.

**Decision:** Settings is for profile + co-host roles; budget cap is domain-specific and grows with the feature (Phase 2: vendor links, Phase 3: pricing seeding). Putting it in the Budget tab keeps the concerns separate and mirrors the "upcoming payments" widget on Overview (another Phase 1 surface).

**Governance:** `weddingOwner()` gate on the `PUT .../budget/cap` endpoint (organiser can only set their own wedding's cap).

## Deferred Items

The following are **intentionally NOT implemented** in v1; tracked in `[[decisions/deferred-decisions]]`:

- **Vendor linkage** (`budget_items.vendor_id`) — Phase 2 couples budget to the CRM; v1 items are free-text placeholders
- **Pricing seeding** — Phase 3 engine will prefill estimates via heuristic baseline (v1 is all manual entry)
- **Multi-currency** — v1 accepts `wedding.currency` only; Phase 3 optional v2 adds display-only `original_currency` + `original_amount_minor` for reference (weddings span countries, but the couple budgets in one currency they think in)
- **Recurring payments** — v1 supports due/paid snapshots; automated recurring series deferred (Phase 4 candidate)
- **Payment reminders** — no outbound email/SMS alerts on due dates (Phase 4: comms automation)
- **Cross-category drag-reorder** — items reorder within their category only; dragging an item to another category (a change of category, not of order) is deferred
