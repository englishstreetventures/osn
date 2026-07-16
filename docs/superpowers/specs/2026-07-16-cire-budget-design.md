# Cire Phase 1: Budget v1 module — design

Date: 2026-07-16
Branch: `feat/cire-budget`
Scope: `cire/db`, `cire/api`, `cire/organiser` (all `@cire/*` — version-less, empty changeset)

## Goal

Second Phase 1 module: a **per-category wedding budget**. Organisers add budget
line items grouped by service category (Venue, Catering, …), track three money
figures per item (estimate → quoted → actual), attach payment schedule rows
(deposit/balance with due + paid dates), and see spend-vs-cap plus an upcoming-
payments feed on the Overview. The overall budget cap lives on the wedding
(`weddings.budget_total_minor`, already shipped) and its editor **moves** into the
Budget tab. All money is single-currency (the wedding's main `currency`) — no FX.

## Settled design decisions (the brainstorm)

Four choices locked with the user:

1. **Three money columns** — each item carries `estimate_minor`, `quoted_minor`,
   `actual_minor` (all nullable), faithful to platform-plan §4.2. The pipeline is
   estimate (what you expect / pricing-engine-seedable later) → quoted (a real
   vendor number) → actual (what it cost). Rollup spend uses
   `actual ?? quoted ?? estimate` per item.
2. **Payments in v1** — a second `payments` table (label, amount, due date, paid
   date) hangs off each item. Feeds the Overview upcoming-payments feed with an
   overdue flag. Not deferred.
3. **Category-grouped view** — items render in sections per service category with
   per-category subtotals (mirrors the shipped Checklist bucket layout). Category
   is **required** on every item (pick from the enum; `other` is the catch-all).
4. **Cap edit moves into the Budget tab** — the `budget_total_minor` editor is
   **removed** from the Settings Profile form and surfaced in the Budget tab
   summary header (owner-only). One edit surface per field, no drift.
   `wedding_date` / `currency` / slug stay in Settings.

## Data model — migration `0039_budget.sql` (two new tables)

Latest migration on `main` is `0038_tasks.sql`; this adds `0039`.

### Shared service-category enum (new single source)

`cire/api/src/lib/service-categories.ts` — the closed enum platform-plan §4.3
mandates, shared by Budget now (first consumer) and Vendors/Tasks/pricing later.
Same shape as the shipped `checklist-buckets.ts`:

```ts
export const SERVICE_CATEGORIES = [
  { key: "venue", label: "Venue" },
  { key: "catering", label: "Catering" },
  { key: "photography", label: "Photography" },
  { key: "videography", label: "Videography" },
  { key: "decor_styling", label: "Décor & styling" },
  { key: "florals", label: "Florals" },
  { key: "music_entertainment", label: "Music & entertainment" },
  { key: "celebrant", label: "Celebrant" },
  { key: "cake", label: "Cake" },
  { key: "stationery", label: "Stationery" },
  { key: "hair_makeup", label: "Hair & makeup" },
  { key: "transport", label: "Transport" },
  { key: "attire", label: "Attire" },
  { key: "other", label: "Other" },
] as const;
export type ServiceCategory = (typeof SERVICE_CATEGORIES)[number]["key"];
export const SERVICE_CATEGORY_KEYS = SERVICE_CATEGORIES.map((c) => c.key);
export function isServiceCategory(v: string): v is ServiceCategory { … }
```

### `budget_items`

```
budget_items
  id              text PK              -- app-minted id (same idiom as tasks/events)
  wedding_id      text NOT NULL        -- FK → weddings(id) ON DELETE CASCADE
  category        text NOT NULL        -- service-category enum
  name            text NOT NULL
  estimate_minor  integer              -- nullable, minor units (cents) of wedding currency
  quoted_minor    integer              -- nullable
  actual_minor    integer              -- nullable
  notes           text                 -- nullable
  sort_order      integer NOT NULL DEFAULT 0   -- order within a category
  created_at      integer NOT NULL     -- ms epoch, Drizzle timestamp mode
  updated_at      integer NOT NULL     -- ms epoch, bumped on every write
```

Index: `CREATE INDEX budget_items_wedding_category_sort ON budget_items(wedding_id, category, sort_order)`
— serves the one grouped read (all items for a wedding, ordered within category).

### `payments`

```
payments
  id              text PK              -- app-minted id
  budget_item_id  text NOT NULL        -- FK → budget_items(id) ON DELETE CASCADE
  label           text NOT NULL        -- 'Deposit' | 'Balance' | free text
  amount_minor    integer NOT NULL     -- minor units; required (a payment always has an amount)
  due_at          text                 -- nullable ISO date (YYYY-MM-DD)
  paid_at         integer              -- nullable ms epoch; set when marked paid
  created_at      integer NOT NULL     -- ms epoch
```

Index: `CREATE INDEX payments_item ON payments(budget_item_id)` — serves the
per-item payment fetch and the wedding-wide upcoming feed (joined through items).

**Money invariant:** every `*_minor` figure is an integer in the wedding's single
`currency` (no floats, no FX). Amounts validated `>= 0` at the schema boundary.

**DDL discipline:** all three surfaces move in lockstep — the numbered migration,
`cire/api/src/db/setup.ts` DDL, and `cire/db/src/schema.ts` Drizzle tables. The
`ddl-lockstep.test.ts` (T-S1) invariant must stay green at 0039 for **both** new
tables. Migration is additive (pure `CREATE TABLE` ×2 + `CREATE INDEX` ×2) — no
rebuild, no prod data risk. Merging auto-applies it to prod D1 via `deploy.yml`
(`d1 migrations apply --remote`); being new empty tables it needs no
columns-empty confirmation, but the merge still needs explicit per-change user
authorization naming prod cire-db (auto-mode migration guardrail).

**Deferred (kept out of v1, all additive later):** `vendor_id` FK on
`budget_items` (Phase 2), pricing-engine estimate seeding (Phase 3), multi-
currency `original_currency`/`original_amount_minor` (see [[deferred]]), recurring
payments, per-payment reminders/notifications.

## API — `/api/organiser/weddings/:weddingId/budget`

Per-row CRUD over two nested resources. Budget sits **outside** the guest/schedule
desired-state reconcile pipeline (like tasks / organiser-recorded RSVPs) — plain
Effect services, not `changes/*`. Every write re-validates wedding-scoped tenancy;
payment writes re-scope through their parent item's `wedding_id` (cross-tenant →
404). Two-factory read/write split (mirrors `tasks` / `organiser-hosts`) to keep
Elysia guard gates from cross-contaminating.

| Method + path | Body | Gate |
|---|---|---|
| `GET    /budget` | — | `weddingMember()` |
| `POST   /budget/items` | `{ category, name, estimateMinor?, quotedMinor?, actualMinor?, notes? }` | `weddingEditor()` |
| `PATCH  /budget/items/reorder` | `{ category, orderedIds: string[] }` | `weddingEditor()` |
| `PATCH  /budget/items/:itemId` | `{ category?, name?, estimateMinor?, quotedMinor?, actualMinor?, notes? }` | `weddingEditor()` |
| `DELETE /budget/items/:itemId` | — | `weddingEditor()` |
| `POST   /budget/items/:itemId/payments` | `{ label, amountMinor, dueAt? }` | `weddingEditor()` |
| `PATCH  /budget/items/:itemId/payments/:paymentId` | `{ label?, amountMinor?, dueAt?, paid? }` | `weddingEditor()` |
| `DELETE /budget/items/:itemId/payments/:paymentId` | — | `weddingEditor()` |
| `PUT    /budget/total` | `{ budgetTotalMinor: number \| null }` | `weddingOwner()` |

- `GET /budget` returns one hydrating payload: `{ items: BudgetItemDto[],
  payments: PaymentDto[], rollup, budgetTotalMinor, currency }`. `items` flat,
  ordered `(category, sort_order)`; `payments` flat, keyed by `budgetItemId`
  (client nests). Any member role reads (viewers included).
- `rollup` is computed server-side (pure): `byCategory: { category, estimate,
  quoted, actual }[]` subtotals + `totals` (grand estimate/quoted/actual) +
  `spentSoFar = Σ(actual ?? quoted ?? estimate)` + `budgetTotalMinor`. The view
  never re-derives money maths from raw rows client-side beyond display.
- `POST items` validates `category` against the shared enum (reject unknown →
  400). New item appends to the end of its category (`sort_order` = max + 1).
  Amounts default `null` when omitted.
- `PATCH items` on `category` is a plain field update (item keeps its
  `sort_order`; acceptable minor imperfection, same as tasks bucket-change).
  `updated_at` bumped on every item write.
- `reorder` sets `sort_order` for each id in `orderedIds` to its array index,
  scoped to (wedding, category), in one D1 transaction. Ids not under the
  wedding/category are ignored (defensive).
- `PATCH payments` with `paid: true` stamps `paid_at = now`; `paid: false` clears
  it to `NULL`. Payment writes validate the parent item is under `:weddingId`.
- `PUT /budget/total` writes `weddings.budget_total_minor` via the **existing**
  `wedding-settings` service (single writer — no new column path), owner-gated to
  match the Settings save it replaces. `null` clears the cap.

Tagged errors: `BudgetItemNotInWedding`, `PaymentNotInItem` (both extend
`Data.TaggedError`) → 404. Effect Schema bodies (`Schema.decodeUnknown`) — same
HTTP-boundary discipline as tasks. Service `cire/api/src/services/budget.ts`,
routes `cire/api/src/routes/budget.ts`, mounted in `src/app.ts` after the task
routes.

## Frontend — `cire/organiser`

- **`lib/service-categories.ts`** — client label mirror of the server enum (the
  organiser can't import `cire/api`), documented to stay in sync — same pattern as
  the shipped `checklist-buckets.ts` client mirror.
- **`lib/budget-store.ts`** — weddingId-keyed cache, sibling of `tasks-store` /
  `guests-store` / `events-store`, with fetch-lift so tab navigation doesn't
  refetch. Exposes `ensureBudgetLoaded`, `peekCachedBudget`, `setCachedBudget`,
  `invalidateBudget`, and derived selectors `spentSoFar(weddingId)` +
  `upcomingPayments(weddingId)` (next unpaid payments by `due_at`, overdue first)
  read side-effect-free from the cache (learn from the checklist `openTaskCount`
  fix — no side-effecting `entryFor`).
- **`components/BudgetView.tsx`** — the module screen. Category-grouped sections
  (labels from the mirror), each with a subtotal header (estimate / actual). Per
  item: name + the three money figures inline-editable; expandable payment rows
  (add / mark-paid toggle / delete); within-category reorder (move up/down, same
  primitive the ChecklistView used); delete. Add-item form (category dropdown +
  name + optional amounts). **Cap editor** in the summary header — owner-only
  inline edit → `PUT /budget/total`; shows "Spent $X of $Y" with under/over state,
  "No budget set" when null. **Viewer role read-only** via `props.canEdit` — no
  add/edit/reorder/cap controls (mirrors existing per-view viewer gating).
  Optimistic mutations reconciled against the store cache; reload on failure.
- **Sidebar promotion** — Budget is an Overview "coming soon" card today. Promote
  it to a real rail module: `MODULES`, `MODULE_SUBS` (`budget: ["index"]`),
  `MODULE_NAV` entry (glyph + hint), `dashboard-route` union widened, `ModuleShell`
  renders `<BudgetView weddingId canEdit>` under a `Show`.
- **Settings Profile form** — **remove** the `budget_total_minor` input (moved to
  Budget). Keep `wedding_date` / `currency` / slug. The `PUT settings` endpoint is
  unchanged (still the single writer; Budget's `PUT /budget/total` delegates to it).
- **Overview widget** — replace the Budget "coming soon" card with a live widget:
  "Spent $X of $Y cap" (honest null → "No budget set", 0 items → "No budget yet")
  **+ an upcoming-payments list** (next unpaid by due date, overdue flagged).
  Fetch-lifted into the existing Overview `Promise.all` load block via
  `budget-store`; `onNavigate` union widened to include `"budget"`.

## Testing

- **Service** (`budget.test.ts`): item create/list/patch/delete; payment
  create/patch(mark-paid clears+sets `paid_at`)/delete; tenancy isolation (wedding
  A cannot read or mutate wedding B's item **or** its payments — includes the
  cross-tenant payment path the checklist review flagged as a gap); reorder
  rewrites `sort_order` in order scoped to (wedding, category); reject unknown
  `category`; rollup maths (`spentSoFar = actual ?? quoted ?? estimate`, per-
  category subtotals); amounts `< 0` rejected.
- **Route** (`budget.route.test.ts`): authz matrix — viewer 403 `read_only_role`
  on every write but 200 on `GET`; non-member rejected; editor writes; member
  reads; owner-only `PUT /budget/total` (editor → 403); cross-tenant item id and
  cross-tenant payment id → 404.
- **DDL/lockstep**: T-S1 green with `budget_items` **and** `payments` at migration
  0039 across all three surfaces.
- **Component**: category grouping + subtotals; add/edit item; add/mark-paid/delete
  payment; reorder; cap edit (owner) + hidden for viewer; Overview spend widget +
  upcoming-payments feed + empty states.

## Slicing + changeset

One cohesive PR: schema + shared enum + API + organiser UI + Settings cap removal
+ Overview widget. Fresh tables, no dependency on other in-flight schema work, so
no split. All touched packages are `@cire/*` (version-less) → **empty changeset**
(`changeset add --empty`), never mixed with `@osn/api`.

## Out of scope (explicit)

`vendor_id` linkage · pricing-engine estimate seeding · multi-currency display ·
recurring payments · payment reminders/notifications · cross-category item drag ·
budget-item comments/attachments · CSV export. Each is a clean later addition on
the additive schema.
