---
title: Cire budget
tags: [system, budget, phase-1, cire]
related:
  - "[[cire-platform-plan]]"
  - "[[cire-checklist-tasks]]"
  - "[[drag-and-drop]]"
  - "[[decisions/deferred-decisions]]"
last-reviewed: 2026-09-25
---
# Budget

Phase 1 Budget v1 module. Organisers add line items under a service category, track estimate → quoted → actual per item, attach payment schedule rows (deposit/balance with due + paid dates), and edit the overall cap from the Budget tab.

## Database Schema

### `budget_items` table (additive migration 0039)

Per-wedding line-item tracker, keyed by category.

- `id` — primary key
- `wedding_id` — foreign key to `weddings`, cascade delete
- `category` — service category string key (e.g., `venue`, `catering`, `photography`)
- `description` — organiser's description (freetext)
- `estimate_minor` — optional estimate amount (minor currency units, NULL allowed)
- `quoted_minor` — optional quoted amount from vendor
- `actual_minor` — optional actual amount paid
- `sortOrder` — reorder within category
- `created_at`, `updated_at` — timestamps

Spend rule: `actual ?? quoted ?? estimate ?? 0` (`itemSpend` on client, `computeRollup` on server).

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
- `GET /api/organiser/weddings/:weddingId/budget` — fetch full snapshot: all items + payments, category rollups (sum per category + total), budgetTotalMinor cap

### Editor writes (owner or `editor` role)
- `POST .../budget/items` — create item (auto-increment sortOrder)
- `PATCH .../budget/items/:itemId` — update description/estimate/quoted/actual
- `DELETE .../budget/items/:itemId` — remove item (deletes cascade to payments)
- `PATCH .../budget/items/reorder` — `{ category, orderedIds }`: the category's new order, written as `sortOrder` = array index. Registered before `.../items/:itemId` so the literal path wins
- `POST .../budget/items/:itemId/payments` — add payment row
- `PATCH .../budget/items/:itemId/payments/:paymentId` — update payment label/amount/due/paid dates
- `DELETE .../budget/items/:itemId/payments/:paymentId` — remove payment row

### Owner cap gate (owner role only)
- `PUT /api/organiser/weddings/:weddingId/budget/total` — update `weddings.budget_total_minor` (moved from Settings module)

**Tenancy:** `BudgetItemNotInWedding` + `PaymentNotInItem` error tags prevent cross-wedding/cross-item access.

## Rollup Spend Rule

**Server rule** (`services/budget.ts::computeRollup`):
```
itemSpend = actual ?? quoted ?? estimate ?? 0
categorySpend = sum of itemSpend per category
totalSpend = sum of itemSpend across all items
```

**Client rule** (organiser `lib/budget-store.ts` + `BudgetView` component):
```
itemSpend = actual ?? quoted ?? estimate ?? 0
(same rule, computed from local state)
```

Both sides use the **same precedence** — no disagreement on what "spent" means. Live budget vs cap comparison: `totalSpend` vs `weddings.budget_total_minor`.

## Client-Store Fetch-Lift

**`cire/host/src/lib/budget-store.ts`** — the `weddingId`-keyed cache of one wedding's budget snapshot (`GET /api/organiser/weddings/:weddingId/budget`), shared by the Budget view and the Overview's budget widget so the two make one request.

- **Writes** — a successful create or edit folds the row the server returns into the cached snapshot. Only a failed write reads the budget again, to undo the optimistic change.
- **Lifetime** — the same contract as its siblings (`guests-store.ts`, `events-store.ts`, `tasks-store.ts` and the rest): stale-while-revalidate after a write, and every row dropped when the wedding's dashboard closes. See [[cire-host-portal-layout#Organiser client caches: stale-while-revalidate]].

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
