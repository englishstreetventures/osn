# Cire Budget v1 Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a per-category wedding budget — organisers add line items grouped by service category, track estimate → quoted → actual per item, attach payment schedule rows (deposit/balance with due + paid dates), edit the overall cap from the Budget tab, and see spend-vs-cap + an upcoming-payments feed on the Overview.

**Architecture:** Two new D1 tables (`budget_items` + `payments`, migration `0039`) + a shared `service-categories.ts` enum (its first consumer). A two-factory read/write CRUD router under `/api/organiser/weddings/:weddingId/budget` (member reads / editor writes) plus an owner-gated `PUT /budget/total` that delegates to the existing `weddingSettingsService`. A new `budget` module in the organiser IA: sidebar entry, `BudgetView` screen, weddingId-keyed `budget-store`, a live Overview spend+payments widget, and the cap editor **removed** from the Settings Profile form.

**Tech Stack:** Cloudflare Workers + Elysia (`aot:false`), Effect.ts + Effect Schema (backend only), Drizzle + D1, hand-written numbered SQL migrations, SolidJS (organiser), bun:test + vitest.

## Global Constraints

- **Migrations are hand-written numbered `.sql`** applied by `wrangler d1 migrations apply`. Latest on `main` = `0038_tasks.sql`; this plan adds **`0039_budget.sql`**. Do NOT run `drizzle-kit generate` (the `_journal.json` is stale).
- **LOCKSTEP DDL invariant (T-S1):** `cire/api/src/db/ddl-lockstep.test.ts` replays the migration chain vs `cire/api/src/db/setup.ts` `DDL` vs `cire/db/src/schema.ts`. All three must agree — the schema change touches all three surfaces in one task, for **both** new tables.
- **Effect is backend + DB only** — never import `effect` in `cire/organiser` or `cire/web`. Organiser code uses plain Solid primitives.
- **HTTP boundary uses Effect Schema** (`Schema.decodeUnknown`) in cire, not TypeBox. Tagged errors extend `Data.TaggedError`; no thrown exceptions in the service layer.
- **Money is integer minor units** (cents) of the wedding's single `currency` — no floats, no FX. Every `*_minor` value validated `>= 0` at the schema boundary.
- **No `console.*` in backend** — use `Effect.logInfo/logWarning/logError`. Never log PII.
- **Changeset required.** All touched packages are `@cire/*` (version-less, ignored) → one **empty** changeset. NEVER mix `@cire/*` with `@osn/api` in a changeset. Package names must match workspace `name` exactly (`@cire/api`, `@cire/db`, `@cire/organiser`).
- **Merging this PR auto-applies `0039` to prod D1** via `deploy.yml` (`d1 migrations apply --remote`). `0039` is a pure additive `CREATE TABLE ×2` on new empty tables — no columns-empty confirmation needed, but the merge still needs explicit per-change user authorization naming prod cire-db (auto-mode migration guardrail). Do not self-merge.
- **Branch:** `feat/cire-budget` (already created). Never commit to `main`. Never `--no-verify` push.
- Run tests with `bun run --cwd cire/api test` (backend, bun:test) and `bun run --cwd cire/organiser test` (organiser, vitest — use the one-shot `test` script which already runs `vitest run`). Type-check with `bun run check`.

---

### Task 1: Schema spine — `budget_items` + `payments` across all three DDL surfaces

**Files:**
- Create: `cire/db/migrations/0039_budget.sql`
- Modify: `cire/api/src/db/setup.ts` (append to `DDL`, before the closing `` ` `` on line 209)
- Modify: `cire/db/src/schema.ts` (add `budgetItems` + `payments` tables after the `tasks` table, ~line 293)
- Test: `cire/api/src/db/ddl-lockstep.test.ts` (existing — the RED/GREEN gate, not edited)

**Interfaces:**
- Produces: Drizzle tables `budgetItems` + `payments` exported from `@cire/db`.
  - `budgetItems` columns: `id, weddingId, category, name, estimateMinor, quotedMinor, actualMinor, notes, sortOrder, createdAt, updatedAt`. `createdAt`/`updatedAt` are `integer(mode:"timestamp")` (Drizzle returns `Date`). `estimateMinor`/`quotedMinor`/`actualMinor` are nullable `integer`.
  - `payments` columns: `id, budgetItemId, label, amountMinor, dueAt, paidAt, createdAt`. `paidAt`/`createdAt` are `integer(mode:"timestamp")`; `dueAt` is `text` (ISO date); `amountMinor` is a non-null `integer`.

- [ ] **Step 1: Add the migration (first surface — lockstep now RED)**

Create `cire/db/migrations/0039_budget.sql`:

```sql
-- Phase 1 Budget v1 ([[platform-plan]] §4.2). A per-category wedding budget:
-- `budget_items` are line items filed under a service category (venue, catering,
-- …) carrying three OPTIONAL money figures (estimate → quoted → actual, all in
-- the wedding's single `currency`, minor units). `payments` are the schedule rows
-- (deposit/balance) that hang off an item with a due date and a paid stamp,
-- feeding the Overview upcoming-payments feed. All money is integer minor units;
-- no floats, no FX. v1 carries no vendor linkage; that's an additive Phase 2 FK.
--
-- Purely additive: two brand-new tables + two indexes. No rebuild, no data touched.
CREATE TABLE `budget_items` (
  `id` text PRIMARY KEY NOT NULL,
  `wedding_id` text NOT NULL REFERENCES `weddings`(`id`) ON DELETE CASCADE,
  `category` text NOT NULL,
  `name` text NOT NULL,
  `estimate_minor` integer,
  `quoted_minor` integer,
  `actual_minor` integer,
  `notes` text,
  `sort_order` integer DEFAULT 0 NOT NULL,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `budget_items_wedding_category_sort_idx` ON `budget_items` (`wedding_id`, `category`, `sort_order`);
--> statement-breakpoint
CREATE TABLE `payments` (
  `id` text PRIMARY KEY NOT NULL,
  `budget_item_id` text NOT NULL REFERENCES `budget_items`(`id`) ON DELETE CASCADE,
  `label` text NOT NULL,
  `amount_minor` integer NOT NULL,
  `due_at` text,
  `paid_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `payments_item_idx` ON `payments` (`budget_item_id`);
```

- [ ] **Step 2: Run the lockstep test — verify it FAILS**

Run: `bun run --cwd cire/api test -- ddl-lockstep`
Expected: FAIL — the migration chain now has `budget_items`/`payments` tables that `setup.ts` DDL and `schema.ts` do not.

- [ ] **Step 3: Mirror in `setup.ts` DDL (second surface)**

In `cire/api/src/db/setup.ts`, append inside the `DDL` template string, immediately before the closing `` ` `` on line 209 (after the `tasks` index line):

```sql

CREATE TABLE IF NOT EXISTS budget_items (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  estimate_minor INTEGER,
  quoted_minor INTEGER,
  actual_minor INTEGER,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_items_wedding_category_sort_idx ON budget_items(wedding_id, category, sort_order);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  budget_item_id TEXT NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  due_at TEXT,
  paid_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_item_idx ON payments(budget_item_id);
```

- [ ] **Step 4: Mirror in `schema.ts` (third surface)**

In `cire/db/src/schema.ts`, add the two tables immediately after the `tasks` table (ends ~line 293). The file already imports `sqliteTable, text, integer, index` from `drizzle-orm/sqlite-core`:

```typescript
export const budgetItems = sqliteTable(
  "budget_items",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    // Service category (shared enum, cire/api/src/lib/service-categories.ts).
    category: text("category").notNull(),
    name: text("name").notNull(),
    // Three OPTIONAL money figures, minor units of the wedding's currency.
    estimateMinor: integer("estimate_minor"),
    quotedMinor: integer("quoted_minor"),
    actualMinor: integer("actual_minor"),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("budget_items_wedding_category_sort_idx").on(t.weddingId, t.category, t.sortOrder),
  ],
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    budgetItemId: text("budget_item_id")
      .notNull()
      .references(() => budgetItems.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    // Optional ISO date (YYYY-MM-DD) the payment is due.
    dueAt: text("due_at"),
    // Set when marked paid; null while outstanding.
    paidAt: integer("paid_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("payments_item_idx").on(t.budgetItemId)],
);
```

- [ ] **Step 5: Run the lockstep test — verify it PASSES**

Run: `bun run --cwd cire/api test -- ddl-lockstep`
Expected: PASS — all three surfaces agree on both new tables.

- [ ] **Step 6: Apply the migration locally (sanity)**

Run: `cd cire/api && bunx wrangler d1 migrations apply cire-db --local`
Expected: applies `0039_budget.sql` with no error.

- [ ] **Step 7: Commit**

```bash
git add cire/db/migrations/0039_budget.sql cire/api/src/db/setup.ts cire/db/src/schema.ts
git commit -m "feat(cire/db): add budget_items + payments tables (migration 0039)"
```

---

### Task 2: Service-category single-source + HTTP schemas

**Files:**
- Create: `cire/api/src/lib/service-categories.ts`
- Create: `cire/api/src/schemas/budget.ts`
- Test: `cire/api/src/schemas/budget.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SERVICE_CATEGORIES: readonly {key, label}[]`, `SERVICE_CATEGORY_KEYS: readonly string[]`, `type ServiceCategory`, `isServiceCategory(v): v is ServiceCategory` — from `lib/service-categories.ts`.
  - `CreateBudgetItemBody`, `UpdateBudgetItemBody`, `ReorderBudgetItemsBody`, `CreatePaymentBody`, `UpdatePaymentBody`, `SetBudgetTotalBody` Effect Schemas + their `Schema.Schema.Type` aliases — from `schemas/budget.ts`.

- [ ] **Step 1: Write the failing test**

Create `cire/api/src/schemas/budget.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { Effect, Schema } from "effect";

import { isServiceCategory, SERVICE_CATEGORY_KEYS } from "../lib/service-categories";
import {
  CreateBudgetItemBody,
  CreatePaymentBody,
  ReorderBudgetItemsBody,
  SetBudgetTotalBody,
  UpdateBudgetItemBody,
  UpdatePaymentBody,
} from "./budget";

const decode = <A, I>(s: Schema.Schema<A, I>, v: unknown) =>
  Effect.runSync(Effect.either(Schema.decodeUnknown(s)(v)));

describe("service categories", () => {
  it("has the fourteen ordered keys ending in 'other'", () => {
    expect(SERVICE_CATEGORY_KEYS).toEqual([
      "venue",
      "catering",
      "photography",
      "videography",
      "decor_styling",
      "florals",
      "music_entertainment",
      "celebrant",
      "cake",
      "stationery",
      "hair_makeup",
      "transport",
      "attire",
      "other",
    ]);
  });

  it("recognises valid + rejects unknown categories", () => {
    expect(isServiceCategory("catering")).toBe(true);
    expect(isServiceCategory("catering_extra")).toBe(false);
  });
});

describe("CreateBudgetItemBody", () => {
  it("accepts a category + name, defaults money + notes to null", () => {
    const r = decode(CreateBudgetItemBody, { category: "venue", name: "Reception venue" });
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") {
      expect(r.right.estimateMinor).toBeNull();
      expect(r.right.quotedMinor).toBeNull();
      expect(r.right.actualMinor).toBeNull();
      expect(r.right.notes).toBeNull();
    }
  });

  it("rejects an unknown category", () => {
    expect(decode(CreateBudgetItemBody, { category: "spaceship", name: "x" })._tag).toBe("Left");
  });

  it("rejects an empty name", () => {
    expect(decode(CreateBudgetItemBody, { category: "venue", name: "" })._tag).toBe("Left");
  });

  it("rejects a negative amount", () => {
    expect(
      decode(CreateBudgetItemBody, { category: "venue", name: "x", estimateMinor: -1 })._tag,
    ).toBe("Left");
  });

  it("rejects a fractional amount (minor units are integers)", () => {
    expect(
      decode(CreateBudgetItemBody, { category: "venue", name: "x", estimateMinor: 10.5 })._tag,
    ).toBe("Left");
  });
});

describe("UpdateBudgetItemBody", () => {
  it("accepts a partial money patch with an explicit null clear", () => {
    expect(decode(UpdateBudgetItemBody, { actualMinor: null })._tag).toBe("Right");
  });
});

describe("ReorderBudgetItemsBody", () => {
  it("accepts a category + ordered ids", () => {
    expect(
      decode(ReorderBudgetItemsBody, { category: "catering", orderedIds: ["a", "b"] })._tag,
    ).toBe("Right");
  });
});

describe("CreatePaymentBody", () => {
  it("accepts a label + amount, defaults dueAt to null", () => {
    const r = decode(CreatePaymentBody, { label: "Deposit", amountMinor: 250000 });
    expect(r._tag).toBe("Right");
    if (r._tag === "Right") expect(r.right.dueAt).toBeNull();
  });

  it("rejects a missing amount", () => {
    expect(decode(CreatePaymentBody, { label: "Deposit" })._tag).toBe("Left");
  });
});

describe("UpdatePaymentBody", () => {
  it("accepts a paid toggle", () => {
    expect(decode(UpdatePaymentBody, { paid: true })._tag).toBe("Right");
  });
});

describe("SetBudgetTotalBody", () => {
  it("accepts a number or null", () => {
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: 4_500_000 })._tag).toBe("Right");
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: null })._tag).toBe("Right");
  });

  it("rejects a negative total", () => {
    expect(decode(SetBudgetTotalBody, { budgetTotalMinor: -1 })._tag).toBe("Left");
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/api test -- schemas/budget`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write the service-category single-source**

Create `cire/api/src/lib/service-categories.ts`:

```typescript
/**
 * The closed set of wedding service categories, in display order. Single source
 * of truth for the SERVER: the Budget HTTP schema's category enum derives from
 * THIS list ([[platform-plan]] §4.3). Budget v1 is the first consumer; Vendors
 * and the pricing engine reuse it later. The organiser client keeps its own
 * label mirror (it can't import cire/api) — keep the two in sync when a category
 * is added or a label reworded. `other` is the required catch-all (always last).
 */
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

export function isServiceCategory(value: string): value is ServiceCategory {
  return (SERVICE_CATEGORY_KEYS as readonly string[]).includes(value);
}
```

- [ ] **Step 4: Write the HTTP schemas**

Create `cire/api/src/schemas/budget.ts`:

```typescript
import { Schema } from "effect";

import { SERVICE_CATEGORIES } from "../lib/service-categories";

const MAX_NAME_CHARS = 200;
const MAX_LABEL_CHARS = 80;
const MAX_NOTES_CHARS = 2000;
// Guard against absurd figures (SQLite INTEGER is 64-bit; this is a sanity cap,
// ~ 9 trillion in minor units). Keeps a fat-fingered paste from overflowing UI.
const MAX_MINOR = 9_000_000_000_000;

// The category enum, sourced from the single list so the two never drift.
const categoryKeys = SERVICE_CATEGORIES.map((c) => c.key) as [string, ...string[]];
const CategorySchema = Schema.Literal(...categoryKeys);

const Name = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_NAME_CHARS));
const Label = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(MAX_LABEL_CHARS));
const Notes = Schema.String.pipe(Schema.maxLength(MAX_NOTES_CHARS));
// A loose ISO date string (YYYY-MM-DD from the date input). Stored as text.
const DueAt = Schema.String.pipe(Schema.maxLength(32));
// A money amount in minor units: a non-negative integer, capped for sanity.
const Minor = Schema.Number.pipe(
  Schema.int(),
  Schema.greaterThanOrEqualTo(0),
  Schema.lessThanOrEqualTo(MAX_MINOR),
);

// Create item: category + name required; the three money figures + notes are
// optional, absent → null.
export const CreateBudgetItemBody = Schema.Struct({
  category: CategorySchema,
  name: Name,
  estimateMinor: Schema.optionalWith(Schema.NullOr(Minor), { default: () => null }),
  quotedMinor: Schema.optionalWith(Schema.NullOr(Minor), { default: () => null }),
  actualMinor: Schema.optionalWith(Schema.NullOr(Minor), { default: () => null }),
  notes: Schema.optionalWith(Schema.NullOr(Notes), { default: () => null }),
});
export type CreateBudgetItemBody = Schema.Schema.Type<typeof CreateBudgetItemBody>;

// Update item: every field optional (a partial patch). Absent field ⇒ unchanged;
// an explicit null on a money field or notes clears it.
export const UpdateBudgetItemBody = Schema.Struct({
  category: Schema.optional(CategorySchema),
  name: Schema.optional(Name),
  estimateMinor: Schema.optional(Schema.NullOr(Minor)),
  quotedMinor: Schema.optional(Schema.NullOr(Minor)),
  actualMinor: Schema.optional(Schema.NullOr(Minor)),
  notes: Schema.optional(Schema.NullOr(Notes)),
});
export type UpdateBudgetItemBody = Schema.Schema.Type<typeof UpdateBudgetItemBody>;

// Reorder: the new order of item ids within one category.
export const ReorderBudgetItemsBody = Schema.Struct({
  category: CategorySchema,
  orderedIds: Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(500)),
});
export type ReorderBudgetItemsBody = Schema.Schema.Type<typeof ReorderBudgetItemsBody>;

// Create payment: label + amount required; dueAt optional, absent → null.
export const CreatePaymentBody = Schema.Struct({
  label: Label,
  amountMinor: Minor,
  dueAt: Schema.optionalWith(Schema.NullOr(DueAt), { default: () => null }),
});
export type CreatePaymentBody = Schema.Schema.Type<typeof CreatePaymentBody>;

// Update payment: partial patch. `paid` toggles the paid stamp (true → now,
// false → clear).
export const UpdatePaymentBody = Schema.Struct({
  label: Schema.optional(Label),
  amountMinor: Schema.optional(Minor),
  dueAt: Schema.optional(Schema.NullOr(DueAt)),
  paid: Schema.optional(Schema.Boolean),
});
export type UpdatePaymentBody = Schema.Schema.Type<typeof UpdatePaymentBody>;

// Set the wedding's overall budget cap (delegates to the settings service).
// The bound MATCHES the settings schema's BudgetTotalMinor (0..100_000_000_000)
// because the settings service does not re-validate the delegated patch — the
// two writers of weddings.budget_total_minor must accept the exact same range.
const BudgetTotal = Schema.Number.pipe(
  Schema.int(),
  Schema.between(0, 100_000_000_000),
);
export const SetBudgetTotalBody = Schema.Struct({
  budgetTotalMinor: Schema.NullOr(BudgetTotal),
});
export type SetBudgetTotalBody = Schema.Schema.Type<typeof SetBudgetTotalBody>;
```

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `bun run --cwd cire/api test -- schemas/budget`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cire/api/src/lib/service-categories.ts cire/api/src/schemas/budget.ts cire/api/src/schemas/budget.test.ts
git commit -m "feat(cire/api): service-category source + budget HTTP schemas"
```

---

### Task 3: Budget service (items + payments CRUD, reorder, rollup, wedding-scoped)

**Files:**
- Create: `cire/api/src/services/budget.ts`
- Test: `cire/api/src/services/budget.test.ts`

**Interfaces:**
- Consumes: `DbService`, `dbQuery` from `../db`; `budgetItems`, `payments`, `weddings` from `@cire/db`; `ServiceCategory` from `../lib/service-categories`.
- Produces:
  - `class BudgetItemNotInWedding extends Data.TaggedError("BudgetItemNotInWedding")`
  - `class PaymentNotInItem extends Data.TaggedError("PaymentNotInItem")`
  - `interface BudgetItemDto { id, weddingId, category, name, estimateMinor: number|null, quotedMinor: number|null, actualMinor: number|null, notes: string|null, sortOrder, createdAt: number, updatedAt: number }`
  - `interface PaymentDto { id, budgetItemId, label, amountMinor: number, dueAt: string|null, paidAt: number|null, createdAt: number }`
  - `interface BudgetRollup { byCategory: { category: string; estimateMinor: number; quotedMinor: number; actualMinor: number; itemCount: number }[]; totals: { estimateMinor: number; quotedMinor: number; actualMinor: number }; spentSoFarMinor: number }`
  - `interface BudgetSnapshot { items: BudgetItemDto[]; payments: PaymentDto[]; rollup: BudgetRollup; budgetTotalMinor: number | null; currency: string }`
  - `budgetService` object with:
    - `get(weddingId): Effect<BudgetSnapshot, never, DbService>`
    - `createItem(input): Effect<BudgetItemDto, never, DbService>`
    - `updateItem(input): Effect<BudgetItemDto, BudgetItemNotInWedding, DbService>`
    - `removeItem(weddingId, itemId): Effect<void, BudgetItemNotInWedding, DbService>`
    - `reorderItems(weddingId, category, orderedIds): Effect<void, never, DbService>`
    - `addPayment(input): Effect<PaymentDto, BudgetItemNotInWedding, DbService>`
    - `updatePayment(input): Effect<PaymentDto, BudgetItemNotInWedding | PaymentNotInItem, DbService>`
    - `removePayment(input): Effect<void, BudgetItemNotInWedding | PaymentNotInItem, DbService>`
- Note: `computeRollup(items)` is exported too so the client mirror + the rollup test share the exact spend rule (`actual ?? quoted ?? estimate ?? 0`).

- [ ] **Step 1: Write the failing test**

Create `cire/api/src/services/budget.test.ts`:

```typescript
import { describe, expect, it } from "bun:test";
import { BOOTSTRAP_WEDDING_ID, budgetItems, payments, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { BudgetItemNotInWedding, budgetService, computeRollup, PaymentNotInItem } from "./budget";

const OTHER = "wed_other";

function db0() {
  const db = createDb(":memory:");
  seedDb(db);
  db.insert(weddings)
    .values({
      id: OTHER,
      slug: "other",
      displayName: "Other",
      ownerOsnProfileId: "usr_bob",
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return db;
}

const run = <A, E>(db: ReturnType<typeof createDb>, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(eff.pipe(Effect.provideService(DbService, db)));

const newItem = (over: Partial<{ category: string; name: string }> = {}) => ({
  weddingId: BOOTSTRAP_WEDDING_ID,
  category: (over.category ?? "venue") as never,
  name: over.name ?? "Reception venue",
  estimateMinor: null,
  quotedMinor: null,
  actualMinor: null,
  notes: null,
});

describe("computeRollup", () => {
  it("spends actual ?? quoted ?? estimate per item", () => {
    const r = computeRollup([
      { category: "venue", estimateMinor: 1000, quotedMinor: 1200, actualMinor: 1250 },
      { category: "catering", estimateMinor: 1800, quotedMinor: null, actualMinor: null },
      { category: "venue", estimateMinor: null, quotedMinor: 500, actualMinor: null },
    ] as never);
    // venue: 1250 (actual) + 500 (quoted); catering: 1800 (estimate)
    expect(r.spentSoFarMinor).toBe(1250 + 500 + 1800);
    const venue = r.byCategory.find((c) => c.category === "venue")!;
    expect(venue.itemCount).toBe(2);
    expect(venue.estimateMinor).toBe(1000);
    expect(r.totals.estimateMinor).toBe(1000 + 1800);
  });
});

describe("budgetService", () => {
  it("creates an item appended to its category and reads it back in the snapshot", async () => {
    const db = db0();
    await run(db, budgetService.createItem(newItem({ name: "Venue A" })));
    await run(db, budgetService.createItem(newItem({ name: "Venue B" })));
    const snap = await run(db, budgetService.get(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(snap)) throw new Error("get failed");
    expect(snap.value.items.map((i) => i.name)).toEqual(["Venue A", "Venue B"]);
    expect(snap.value.items.map((i) => i.sortOrder)).toEqual([0, 1]);
    expect(snap.value.currency).toBe("AUD");
  });

  it("updates an item's money and rejects a cross-tenant patch", async () => {
    const db = db0();
    const created = await run(db, budgetService.createItem(newItem()));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const id = created.value.id;

    const ok = await run(db, budgetService.updateItem({
      weddingId: BOOTSTRAP_WEDDING_ID, itemId: id, patch: { actualMinor: 1250000 },
    }));
    if (!Exit.isSuccess(ok)) throw new Error("update failed");
    expect(ok.value.actualMinor).toBe(1250000);

    const foreign = await run(db, budgetService.updateItem({
      weddingId: OTHER, itemId: id, patch: { name: "hijack" },
    }));
    expect(Exit.isFailure(foreign)).toBe(true);
    if (Exit.isFailure(foreign)) {
      expect(
        foreign.cause._tag === "Fail" && foreign.cause.error instanceof BudgetItemNotInWedding,
      ).toBe(true);
    }
    const row = db.select({ name: budgetItems.name }).from(budgetItems).where(eq(budgetItems.id, id)).get();
    expect(row?.name).toBe("Reception venue");
  });

  it("reorders items within a category by array index", async () => {
    const db = db0();
    const ids: string[] = [];
    for (const name of ["A", "B", "C"]) {
      const r = await run(db, budgetService.createItem(newItem({ category: "catering", name })));
      if (!Exit.isSuccess(r)) throw new Error("create failed");
      ids.push(r.value.id);
    }
    await run(db, budgetService.reorderItems(BOOTSTRAP_WEDDING_ID, "catering" as never, [ids[2]!, ids[0]!, ids[1]!]));
    const snap = await run(db, budgetService.get(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(snap)) throw new Error("get failed");
    expect(snap.value.items.filter((i) => i.category === "catering").map((i) => i.name)).toEqual([
      "C", "A", "B",
    ]);
  });

  it("adds a payment, marks it paid then unpaid, and blocks a cross-tenant add", async () => {
    const db = db0();
    const created = await run(db, budgetService.createItem(newItem()));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const itemId = created.value.id;

    const pay = await run(db, budgetService.addPayment({
      weddingId: BOOTSTRAP_WEDDING_ID, itemId, label: "Deposit", amountMinor: 250000, dueAt: "2026-03-01",
    }));
    if (!Exit.isSuccess(pay)) throw new Error("add payment failed");
    expect(pay.value.paidAt).toBeNull();

    const paid = await run(db, budgetService.updatePayment({
      weddingId: BOOTSTRAP_WEDDING_ID, itemId, paymentId: pay.value.id, patch: { paid: true },
    }));
    if (!Exit.isSuccess(paid)) throw new Error("mark paid failed");
    expect(typeof paid.value.paidAt).toBe("number");

    const unpaid = await run(db, budgetService.updatePayment({
      weddingId: BOOTSTRAP_WEDDING_ID, itemId, paymentId: pay.value.id, patch: { paid: false },
    }));
    if (!Exit.isSuccess(unpaid)) throw new Error("unmark failed");
    expect(unpaid.value.paidAt).toBeNull();

    // Cross-tenant add: the item is not under OTHER → BudgetItemNotInWedding.
    const foreign = await run(db, budgetService.addPayment({
      weddingId: OTHER, itemId, label: "X", amountMinor: 1, dueAt: null,
    }));
    expect(Exit.isFailure(foreign)).toBe(true);
    if (Exit.isFailure(foreign)) {
      expect(
        foreign.cause._tag === "Fail" && foreign.cause.error instanceof BudgetItemNotInWedding,
      ).toBe(true);
    }
  });

  it("rejects updating a payment under the wrong item (PaymentNotInItem)", async () => {
    const db = db0();
    const a = await run(db, budgetService.createItem(newItem({ name: "A" })));
    const b = await run(db, budgetService.createItem(newItem({ name: "B" })));
    if (!Exit.isSuccess(a) || !Exit.isSuccess(b)) throw new Error("create failed");
    const pay = await run(db, budgetService.addPayment({
      weddingId: BOOTSTRAP_WEDDING_ID, itemId: a.value.id, label: "Deposit", amountMinor: 100, dueAt: null,
    }));
    if (!Exit.isSuccess(pay)) throw new Error("add failed");
    // Same wedding, but the payment belongs to item A, not item B.
    const wrong = await run(db, budgetService.updatePayment({
      weddingId: BOOTSTRAP_WEDDING_ID, itemId: b.value.id, paymentId: pay.value.id, patch: { paid: true },
    }));
    expect(Exit.isFailure(wrong)).toBe(true);
    if (Exit.isFailure(wrong)) {
      expect(wrong.cause._tag === "Fail" && wrong.cause.error instanceof PaymentNotInItem).toBe(true);
    }
  });

  it("removes an item (cascading its payments) and rejects a cross-tenant delete", async () => {
    const db = db0();
    const created = await run(db, budgetService.createItem(newItem()));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const itemId = created.value.id;
    await run(db, budgetService.addPayment({
      weddingId: BOOTSTRAP_WEDDING_ID, itemId, label: "Deposit", amountMinor: 100, dueAt: null,
    }));

    const foreign = await run(db, budgetService.removeItem(OTHER, itemId));
    expect(Exit.isFailure(foreign)).toBe(true);

    const own = await run(db, budgetService.removeItem(BOOTSTRAP_WEDDING_ID, itemId));
    expect(Exit.isSuccess(own)).toBe(true);
    expect(db.select().from(budgetItems).where(eq(budgetItems.id, itemId)).all().length).toBe(0);
    expect(db.select().from(payments).where(eq(payments.budgetItemId, itemId)).all().length).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/api test -- services/budget`
Expected: FAIL — `./budget` not found.

- [ ] **Step 3: Write the service**

Create `cire/api/src/services/budget.ts`:

```typescript
/**
 * Budget v1 (platform Phase 1, [[platform-plan]] §4.2) — per-row CRUD over a
 * wedding's budget items + their payment schedule. Its OWN service, NOT routed
 * through `changes/*`: budget sits outside the guest/schedule reconcile pipeline.
 *
 * TENANCY: the route gate proves the caller may touch `weddingId`. Every write
 * here ADDITIONALLY scopes by `wedding_id` (payments re-scope through their
 * parent item's `wedding_id`), so an editor of wedding A can never mutate wedding
 * B's item or payment even with a leaked id — a mismatch fails
 * `BudgetItemNotInWedding` / `PaymentNotInItem` rather than touching a row.
 *
 * MONEY: every `*_minor` is an integer in the wedding's single `currency`. The
 * rollup's spend rule is `actual ?? quoted ?? estimate ?? 0` per item, shared
 * with the client via the exported `computeRollup`.
 */
import { budgetItems, payments, weddings } from "@cire/db";
import { and, asc, eq } from "drizzle-orm";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { ServiceCategory } from "../lib/service-categories";

/** No item with this id under this wedding (missing or another wedding's). 404-class. */
export class BudgetItemNotInWedding extends Data.TaggedError("BudgetItemNotInWedding") {}
/** No payment with this id under this item (missing or another item's). 404-class. */
export class PaymentNotInItem extends Data.TaggedError("PaymentNotInItem") {}

export interface BudgetItemDto {
  id: string;
  weddingId: string;
  category: string;
  name: string;
  estimateMinor: number | null;
  quotedMinor: number | null;
  actualMinor: number | null;
  notes: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentDto {
  id: string;
  budgetItemId: string;
  label: string;
  amountMinor: number;
  dueAt: string | null;
  paidAt: number | null;
  createdAt: number;
}

export interface BudgetRollup {
  byCategory: {
    category: string;
    estimateMinor: number;
    quotedMinor: number;
    actualMinor: number;
    itemCount: number;
  }[];
  totals: { estimateMinor: number; quotedMinor: number; actualMinor: number };
  spentSoFarMinor: number;
}

export interface BudgetSnapshot {
  items: BudgetItemDto[];
  payments: PaymentDto[];
  rollup: BudgetRollup;
  budgetTotalMinor: number | null;
  currency: string;
}

export interface CreateBudgetItemInput {
  weddingId: string;
  category: ServiceCategory;
  name: string;
  estimateMinor: number | null;
  quotedMinor: number | null;
  actualMinor: number | null;
  notes: string | null;
}

export interface UpdateBudgetItemPatch {
  category?: ServiceCategory;
  name?: string;
  estimateMinor?: number | null;
  quotedMinor?: number | null;
  actualMinor?: number | null;
  notes?: string | null;
}

interface ItemRow {
  id: string;
  weddingId: string;
  category: string;
  name: string;
  estimateMinor: number | null;
  quotedMinor: number | null;
  actualMinor: number | null;
  notes: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

interface PaymentRow {
  id: string;
  budgetItemId: string;
  label: string;
  amountMinor: number;
  dueAt: string | null;
  paidAt: Date | null;
  createdAt: Date;
}

const toItemDto = (r: ItemRow): BudgetItemDto => ({
  id: r.id,
  weddingId: r.weddingId,
  category: r.category,
  name: r.name,
  estimateMinor: r.estimateMinor,
  quotedMinor: r.quotedMinor,
  actualMinor: r.actualMinor,
  notes: r.notes,
  sortOrder: r.sortOrder,
  createdAt: r.createdAt.getTime(),
  updatedAt: r.updatedAt.getTime(),
});

const toPaymentDto = (r: PaymentRow): PaymentDto => ({
  id: r.id,
  budgetItemId: r.budgetItemId,
  label: r.label,
  amountMinor: r.amountMinor,
  dueAt: r.dueAt,
  paidAt: r.paidAt ? r.paidAt.getTime() : null,
  createdAt: r.createdAt.getTime(),
});

/** The spend rule + subtotals, pure so the client mirror and the test agree. */
export function computeRollup(
  items: Pick<BudgetItemDto, "category" | "estimateMinor" | "quotedMinor" | "actualMinor">[],
): BudgetRollup {
  const byKey = new Map<string, BudgetRollup["byCategory"][number]>();
  let spentSoFarMinor = 0;
  const totals = { estimateMinor: 0, quotedMinor: 0, actualMinor: 0 };
  for (const it of items) {
    let bucket = byKey.get(it.category);
    if (!bucket) {
      bucket = { category: it.category, estimateMinor: 0, quotedMinor: 0, actualMinor: 0, itemCount: 0 };
      byKey.set(it.category, bucket);
    }
    bucket.itemCount += 1;
    bucket.estimateMinor += it.estimateMinor ?? 0;
    bucket.quotedMinor += it.quotedMinor ?? 0;
    bucket.actualMinor += it.actualMinor ?? 0;
    totals.estimateMinor += it.estimateMinor ?? 0;
    totals.quotedMinor += it.quotedMinor ?? 0;
    totals.actualMinor += it.actualMinor ?? 0;
    spentSoFarMinor += it.actualMinor ?? it.quotedMinor ?? it.estimateMinor ?? 0;
  }
  return { byCategory: [...byKey.values()], totals, spentSoFarMinor };
}

/** Load the item, scoped to the wedding, or fail 404-class. Shared by the
 *  payment writes (which must prove the parent item belongs to the wedding). */
function requireItem(
  weddingId: string,
  itemId: string,
): Effect.Effect<ItemRow, BudgetItemNotInWedding, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const [row] = yield* dbQuery(() =>
      db
        .select()
        .from(budgetItems)
        .where(and(eq(budgetItems.id, itemId), eq(budgetItems.weddingId, weddingId)))
        .all(),
    );
    if (!row) return yield* Effect.fail(new BudgetItemNotInWedding());
    return row as ItemRow;
  });
}

export const budgetService = {
  get(weddingId: string): Effect.Effect<BudgetSnapshot, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const itemRows = yield* dbQuery(() =>
        db
          .select()
          .from(budgetItems)
          .where(eq(budgetItems.weddingId, weddingId))
          .orderBy(asc(budgetItems.category), asc(budgetItems.sortOrder))
          .all(),
      );
      const items = (itemRows as ItemRow[]).map(toItemDto);
      // Payments for this wedding's items (join through the item's wedding_id).
      const paymentRows = yield* dbQuery(() =>
        db
          .select({
            id: payments.id,
            budgetItemId: payments.budgetItemId,
            label: payments.label,
            amountMinor: payments.amountMinor,
            dueAt: payments.dueAt,
            paidAt: payments.paidAt,
            createdAt: payments.createdAt,
          })
          .from(payments)
          .innerJoin(budgetItems, eq(payments.budgetItemId, budgetItems.id))
          .where(eq(budgetItems.weddingId, weddingId))
          .all(),
      );
      const paymentDtos = (paymentRows as PaymentRow[]).map(toPaymentDto);
      const [wedding] = yield* dbQuery(() =>
        db
          .select({ budgetTotalMinor: weddings.budgetTotalMinor, currency: weddings.currency })
          .from(weddings)
          .where(eq(weddings.id, weddingId))
          .all(),
      );
      return {
        items,
        payments: paymentDtos,
        rollup: computeRollup(items),
        budgetTotalMinor: wedding?.budgetTotalMinor ?? null,
        currency: wedding?.currency ?? "AUD",
      };
    }).pipe(Effect.withSpan("cire.budget.get"));
  },

  createItem(input: CreateBudgetItemInput): Effect.Effect<BudgetItemDto, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Append to the end of the category: next sort_order = current max + 1.
      const existing = yield* dbQuery(() =>
        db
          .select({ sortOrder: budgetItems.sortOrder })
          .from(budgetItems)
          .where(
            and(eq(budgetItems.weddingId, input.weddingId), eq(budgetItems.category, input.category)),
          )
          .all(),
      );
      const maxSort = (existing as { sortOrder: number }[]).reduce((m, r) => Math.max(m, r.sortOrder), -1);
      const id = `bit_${crypto.randomUUID()}`;
      const now = new Date();
      const row: ItemRow = {
        id,
        weddingId: input.weddingId,
        category: input.category,
        name: input.name,
        estimateMinor: input.estimateMinor,
        quotedMinor: input.quotedMinor,
        actualMinor: input.actualMinor,
        notes: input.notes,
        sortOrder: maxSort + 1,
        createdAt: now,
        updatedAt: now,
      };
      yield* dbQuery(() => db.insert(budgetItems).values(row).run());
      return toItemDto(row);
    }).pipe(Effect.withSpan("cire.budget.createItem"));
  },

  updateItem(input: {
    weddingId: string;
    itemId: string;
    patch: UpdateBudgetItemPatch;
  }): Effect.Effect<BudgetItemDto, BudgetItemNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, patch } = input;
      yield* requireItem(weddingId, itemId);

      const set: Partial<ItemRow> = { updatedAt: new Date() };
      if (patch.category !== undefined) set.category = patch.category;
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.estimateMinor !== undefined) set.estimateMinor = patch.estimateMinor;
      if (patch.quotedMinor !== undefined) set.quotedMinor = patch.quotedMinor;
      if (patch.actualMinor !== undefined) set.actualMinor = patch.actualMinor;
      if (patch.notes !== undefined) set.notes = patch.notes;

      yield* dbQuery(() =>
        db
          .update(budgetItems)
          .set(set)
          .where(and(eq(budgetItems.id, itemId), eq(budgetItems.weddingId, weddingId)))
          .run(),
      );
      const updated = yield* requireItem(weddingId, itemId);
      return toItemDto(updated);
    }).pipe(Effect.withSpan("cire.budget.updateItem"));
  },

  removeItem(
    weddingId: string,
    itemId: string,
  ): Effect.Effect<void, BudgetItemNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* requireItem(weddingId, itemId);
      // Payments cascade via the FK ON DELETE CASCADE.
      yield* dbQuery(() =>
        db
          .delete(budgetItems)
          .where(and(eq(budgetItems.id, itemId), eq(budgetItems.weddingId, weddingId)))
          .run(),
      );
    }).pipe(Effect.withSpan("cire.budget.removeItem"));
  },

  reorderItems(
    weddingId: string,
    category: ServiceCategory,
    orderedIds: readonly string[],
  ): Effect.Effect<void, never, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      // Each id gets its array index as sort_order, scoped to (wedding, category)
      // so a foreign or wrong-category id is a no-op UPDATE rather than a write.
      yield* dbQuery(() =>
        db.transaction((tx) => {
          orderedIds.forEach((id, index) => {
            tx.update(budgetItems)
              .set({ sortOrder: index })
              .where(
                and(
                  eq(budgetItems.id, id),
                  eq(budgetItems.weddingId, weddingId),
                  eq(budgetItems.category, category),
                ),
              )
              .run();
          });
        }),
      );
    }).pipe(Effect.withSpan("cire.budget.reorderItems"));
  },

  addPayment(input: {
    weddingId: string;
    itemId: string;
    label: string;
    amountMinor: number;
    dueAt: string | null;
  }): Effect.Effect<PaymentDto, BudgetItemNotInWedding, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      yield* requireItem(input.weddingId, input.itemId);
      const id = `pay_${crypto.randomUUID()}`;
      const now = new Date();
      const row: PaymentRow = {
        id,
        budgetItemId: input.itemId,
        label: input.label,
        amountMinor: input.amountMinor,
        dueAt: input.dueAt,
        paidAt: null,
        createdAt: now,
      };
      yield* dbQuery(() => db.insert(payments).values(row).run());
      return toPaymentDto(row);
    }).pipe(Effect.withSpan("cire.budget.addPayment"));
  },

  updatePayment(input: {
    weddingId: string;
    itemId: string;
    paymentId: string;
    patch: { label?: string; amountMinor?: number; dueAt?: string | null; paid?: boolean };
  }): Effect.Effect<PaymentDto, BudgetItemNotInWedding | PaymentNotInItem, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, paymentId, patch } = input;
      yield* requireItem(weddingId, itemId);
      const [existing] = yield* dbQuery(() =>
        db
          .select()
          .from(payments)
          .where(and(eq(payments.id, paymentId), eq(payments.budgetItemId, itemId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new PaymentNotInItem());

      const set: Partial<PaymentRow> = {};
      if (patch.label !== undefined) set.label = patch.label;
      if (patch.amountMinor !== undefined) set.amountMinor = patch.amountMinor;
      if (patch.dueAt !== undefined) set.dueAt = patch.dueAt;
      if (patch.paid !== undefined) set.paidAt = patch.paid ? new Date() : null;

      yield* dbQuery(() =>
        db
          .update(payments)
          .set(set)
          .where(and(eq(payments.id, paymentId), eq(payments.budgetItemId, itemId)))
          .run(),
      );
      const [updated] = yield* dbQuery(() =>
        db.select().from(payments).where(eq(payments.id, paymentId)).all(),
      );
      return toPaymentDto(updated as PaymentRow);
    }).pipe(Effect.withSpan("cire.budget.updatePayment"));
  },

  removePayment(input: {
    weddingId: string;
    itemId: string;
    paymentId: string;
  }): Effect.Effect<void, BudgetItemNotInWedding | PaymentNotInItem, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const { weddingId, itemId, paymentId } = input;
      yield* requireItem(weddingId, itemId);
      const [existing] = yield* dbQuery(() =>
        db
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.id, paymentId), eq(payments.budgetItemId, itemId)))
          .all(),
      );
      if (!existing) return yield* Effect.fail(new PaymentNotInItem());
      yield* dbQuery(() =>
        db.delete(payments).where(and(eq(payments.id, paymentId), eq(payments.budgetItemId, itemId))).run(),
      );
    }).pipe(Effect.withSpan("cire.budget.removePayment"));
  },
};
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `bun run --cwd cire/api test -- services/budget`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add cire/api/src/services/budget.ts cire/api/src/services/budget.test.ts
git commit -m "feat(cire/api): budget service (items + payments CRUD, reorder, rollup)"
```

---

### Task 4: Budget routes + mount (two-factory read/write split + owner-gated cap)

**Files:**
- Create: `cire/api/src/routes/budget.ts`
- Modify: `cire/api/src/app.ts` (import + two `.use(...)` after the task routes, ~line 323)
- Test: `cire/api/src/routes/budget.test.ts`

**Interfaces:**
- Consumes: `budgetService`, `BudgetItemNotInWedding`, `PaymentNotInItem` (Task 3); the budget schemas (Task 2); `weddingSettingsService` from `../services/wedding-settings`; `weddingMember`, `weddingEditor`, `weddingOwner`, `osnAuth`, `runCire`, `DbService`.
- Produces: `createBudgetReadRoutes(db, osnAuthOptions)` + `createBudgetWriteRoutes(db, osnAuthOptions)` Elysia factories. Endpoints under `/api/organiser/weddings/:weddingId`:
  - `GET /budget` → `BudgetSnapshot` (weddingMember)
  - `POST /budget/items` → `{ item }` (weddingEditor)
  - `PATCH /budget/items/reorder` → `{ ok: true }` (weddingEditor)
  - `PATCH /budget/items/:itemId` → `{ item }` (weddingEditor)
  - `DELETE /budget/items/:itemId` → `{ ok: true }` (weddingEditor)
  - `POST /budget/items/:itemId/payments` → `{ payment }` (weddingEditor)
  - `PATCH /budget/items/:itemId/payments/:paymentId` → `{ payment }` (weddingEditor)
  - `DELETE /budget/items/:itemId/payments/:paymentId` → `{ ok: true }` (weddingEditor)
  - `PUT /budget/total` → `{ budgetTotalMinor }` (weddingOwner)

**Why two factories:** the shipped tasks module split reads (`weddingMember`) and writes (`weddingEditor`) into separate Elysia factories so the guards never cross-contaminate (see `createTaskReadRoutes`/`createTaskWriteRoutes` in `app.ts`). Budget adds a THIRD gate (`weddingOwner` for `PUT /budget/total`) — fold it into the write factory as its own `.group(...).use(weddingOwner(db))` branch, OR (cleaner) a small third factory. This plan uses **two** factories: a read factory (member GET) and a write factory that mounts editor writes under one `weddingEditor` group and the owner cap-set under a sibling `weddingOwner` group. Register `/budget/items/reorder` BEFORE `/budget/items/:itemId` so the literal wins over the param.

- [ ] **Step 1: Write the failing test**

Create `cire/api/src/routes/budget.test.ts`:

```typescript
import { beforeAll, describe, expect, it } from "bun:test";
import { BOOTSTRAP_WEDDING_ID, weddingHosts, weddings } from "@cire/db";

import { createApp } from "../app";
import { createDb, seedDb } from "../db/setup";
import { appRequest } from "../test-helpers";
import { makeOsnTestAuth } from "../test-helpers/osn-token";
import type { OsnTestAuth } from "../test-helpers/osn-token";

const OWNER = "usr_dev_bootstrap_owner";
const EDITOR = "usr_editor";
const VIEWER = "usr_viewer";
const STRANGER = "usr_stranger";

let auth: OsnTestAuth;
beforeAll(async () => {
  auth = await makeOsnTestAuth();
});

function buildApp() {
  const db = createDb(":memory:");
  seedDb(db);
  const now = new Date();
  db.insert(weddingHosts).values({
    id: "whost_editor", weddingId: BOOTSTRAP_WEDDING_ID, osnProfileId: EDITOR,
    addedByOsnProfileId: OWNER, role: "editor", createdAt: now,
  }).run();
  db.insert(weddingHosts).values({
    id: "whost_viewer", weddingId: BOOTSTRAP_WEDDING_ID, osnProfileId: VIEWER,
    addedByOsnProfileId: OWNER, role: "viewer", createdAt: now,
  }).run();
  db.insert(weddings).values({
    id: "wed_other", slug: "other-wedding", displayName: "Other",
    ownerOsnProfileId: "usr_bob", createdAt: now, updatedAt: now,
  }).run();
  return createApp(db, { osnTestKey: auth.key });
}
type App = ReturnType<typeof buildApp>;

async function req(
  app: App, method: string, path: string, profileId: string | undefined, body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (profileId) headers.Authorization = `Bearer ${await auth.sign(profileId)}`;
  return appRequest(app, path, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const base = `/api/organiser/weddings/${BOOTSTRAP_WEDDING_ID}/budget`;
const ITEM = { category: "venue", name: "Reception venue", estimateMinor: 1200000 };

describe("budget routes", () => {
  it("401 without a token", async () => {
    expect((await req(buildApp(), "GET", base, undefined)).status).toBe(401);
  });

  it("member (viewer) may read", async () => {
    expect((await req(buildApp(), "GET", base, VIEWER)).status).toBe(200);
  });

  it("viewer may NOT create an item (403 read_only_role)", async () => {
    const res = await req(buildApp(), "POST", `${base}/items`, VIEWER, ITEM);
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("read_only_role");
  });

  it("stranger is forbidden", async () => {
    expect((await req(buildApp(), "GET", base, STRANGER)).status).toBe(403);
  });

  it("editor creates an item, adds a payment, marks it paid, and deletes", async () => {
    const app = buildApp();
    const created = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    expect(created.status).toBe(200);
    const { item } = (await created.json()) as { item: { id: string } };

    const snap = await req(app, "GET", base, EDITOR);
    const body = (await snap.json()) as { items: unknown[]; currency: string };
    expect(body.items.length).toBe(1);
    expect(body.currency).toBe("AUD");

    const pay = await req(app, "POST", `${base}/items/${item.id}/payments`, EDITOR, {
      label: "Deposit", amountMinor: 250000, dueAt: "2026-03-01",
    });
    expect(pay.status).toBe(200);
    const { payment } = (await pay.json()) as { payment: { id: string; paidAt: number | null } };
    expect(payment.paidAt).toBeNull();

    const paid = await req(app, "PATCH", `${base}/items/${item.id}/payments/${payment.id}`, EDITOR, {
      paid: true,
    });
    expect(paid.status).toBe(200);
    expect(((await paid.json()) as { payment: { paidAt: number | null } }).payment.paidAt).not.toBeNull();

    const del = await req(app, "DELETE", `${base}/items/${item.id}`, EDITOR);
    expect(del.status).toBe(200);
  });

  it("400 on an unknown category", async () => {
    const res = await req(buildApp(), "POST", `${base}/items`, EDITOR, { category: "ufo", name: "x" });
    expect(res.status).toBe(400);
  });

  it("404 patching an item under the wrong wedding (tenancy)", async () => {
    const app = buildApp();
    const created = await req(app, "POST", `${base}/items`, EDITOR, ITEM);
    const { item } = (await created.json()) as { item: { id: string } };
    const otherPath = `/api/organiser/weddings/wed_other/budget/items/${item.id}`;
    const res = await req(app, "PATCH", otherPath, "usr_bob", { name: "hijack" });
    expect(res.status).toBe(404);
  });

  it("owner may set the cap; editor may not (403)", async () => {
    const app = buildApp();
    const editorTry = await req(app, "PUT", `${base}/total`, EDITOR, { budgetTotalMinor: 4500000 });
    expect(editorTry.status).toBe(403);

    const ownerSet = await req(app, "PUT", `${base}/total`, OWNER, { budgetTotalMinor: 4500000 });
    expect(ownerSet.status).toBe(200);

    const snap = await req(app, "GET", base, OWNER);
    expect(((await snap.json()) as { budgetTotalMinor: number }).budgetTotalMinor).toBe(4500000);
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/api test -- routes/budget`
Expected: FAIL — routes not mounted (GET returns 404).

- [ ] **Step 3: Write the routes**

Create `cire/api/src/routes/budget.ts`:

```typescript
import { Effect, Schema } from "effect";
import { Elysia } from "elysia";

import { DbService } from "../db";
import type { Db } from "../db";
import { osnAuth } from "../middleware/osn-auth";
import type { OsnAuthOptions } from "../middleware/osn-auth";
import { weddingEditor } from "../middleware/wedding-editor";
import { weddingMember } from "../middleware/wedding-member";
import { weddingOwner } from "../middleware/wedding-owner";
import { runCire } from "../observability";
import {
  CreateBudgetItemBody,
  CreatePaymentBody,
  ReorderBudgetItemsBody,
  SetBudgetTotalBody,
  UpdateBudgetItemBody,
  UpdatePaymentBody,
} from "../schemas/budget";
import { budgetService } from "../services/budget";
import { weddingSettingsService } from "../services/wedding-settings";

// Sentinel parse hook — the handler parses by hand so a malformed payload
// degrades to the schema's 400 (same idiom as the other organiser write routes).
const manualParse = { parse: () => ({}) };

const badRequest = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 400;
    return { error: "Missing or invalid fields" };
  });

const itemNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "budget_item_not_found" };
  });

const paymentNotFound = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 404;
    return { error: "payment_not_found" };
  });

const internal = (set: { status?: number | string }) =>
  Effect.sync(() => {
    set.status = 500;
    return { error: "Internal error" };
  });

function internalSync(set: { status?: number | string }) {
  set.status = 500;
  return { error: "Internal error" };
}

/**
 * Budget v1 — READ surface (platform Phase 1, [[platform-plan]] §4.2):
 *
 *   GET /api/organiser/weddings/:weddingId/budget   (weddingMember — any role incl. viewer)
 *
 * Split from the write factory so the read gate (weddingMember) never
 * cross-contaminates the write gates. Mirrors createTaskReadRoutes.
 */
export const createBudgetReadRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group.use(weddingMember(db)).get("/budget", async ({ weddingId, set }) => {
        if (!weddingId) return internalSync(set);
        return runCire(
          budgetService.get(weddingId).pipe(
            Effect.provideService(DbService, db),
            Effect.catchAllDefect(() => internal(set)),
          ),
        );
      }),
    );

/**
 * Budget v1 — WRITE surface (platform Phase 1, [[platform-plan]] §4.2):
 *
 *   POST   /budget/items                                   (weddingEditor)
 *   PATCH  /budget/items/reorder                           (weddingEditor)
 *   PATCH  /budget/items/:itemId                           (weddingEditor)
 *   DELETE /budget/items/:itemId                           (weddingEditor)
 *   POST   /budget/items/:itemId/payments                  (weddingEditor)
 *   PATCH  /budget/items/:itemId/payments/:paymentId       (weddingEditor)
 *   DELETE /budget/items/:itemId/payments/:paymentId       (weddingEditor)
 *   PUT    /budget/total                                   (weddingOwner)
 *
 * A viewer gets 403 `read_only_role` on the editor writes; an editor gets 403 on
 * `PUT /budget/total` (owner-only, matching the Settings save it replaces). The
 * service re-scopes every write by wedding_id (payments via their parent item),
 * so a cross-tenant id 404s. `PUT /budget/total` delegates to the settings
 * service so `weddings.budget_total_minor` keeps ONE writer.
 *
 * NOTE `/budget/items/reorder` is registered BEFORE `/budget/items/:itemId` so
 * the literal wins over the param.
 */
export const createBudgetWriteRoutes = (db: Db, osnAuthOptions: OsnAuthOptions) =>
  new Elysia({ prefix: "/api/organiser" })
    .use(osnAuth(osnAuthOptions))
    .group("/weddings/:weddingId", (group) =>
      group
        // Editor writes.
        .guard((write) =>
          write
            .use(weddingEditor(db))
            .post(
              "/budget/items",
              async ({ weddingId, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(CreateBudgetItemBody)(raw);
                    const item = yield* budgetService.createItem({ weddingId, ...body });
                    return { item };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .patch(
              "/budget/items/reorder",
              async ({ weddingId, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(ReorderBudgetItemsBody)(raw);
                    yield* budgetService.reorderItems(weddingId, body.category, body.orderedIds);
                    return { ok: true as const };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .patch(
              "/budget/items/:itemId",
              async ({ weddingId, params, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(UpdateBudgetItemBody)(raw);
                    const item = yield* budgetService.updateItem({
                      weddingId,
                      itemId: params.itemId,
                      patch: body,
                    });
                    return { item };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .delete("/budget/items/:itemId", async ({ weddingId, params, set }) => {
              if (!weddingId) return internalSync(set);
              return runCire(
                budgetService.removeItem(weddingId, params.itemId).pipe(
                  Effect.map(() => ({ ok: true as const })),
                  Effect.provideService(DbService, db),
                  Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            })
            .post(
              "/budget/items/:itemId/payments",
              async ({ weddingId, params, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(CreatePaymentBody)(raw);
                    const payment = yield* budgetService.addPayment({
                      weddingId,
                      itemId: params.itemId,
                      label: body.label,
                      amountMinor: body.amountMinor,
                      dueAt: body.dueAt,
                    });
                    return { payment };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .patch(
              "/budget/items/:itemId/payments/:paymentId",
              async ({ weddingId, params, request, set }) => {
                if (!weddingId) return internalSync(set);
                const raw: unknown = await request.json().catch(() => null);
                return runCire(
                  Effect.gen(function* () {
                    const body = yield* Schema.decodeUnknown(UpdatePaymentBody)(raw);
                    const payment = yield* budgetService.updatePayment({
                      weddingId,
                      itemId: params.itemId,
                      paymentId: params.paymentId,
                      patch: body,
                    });
                    return { payment };
                  }).pipe(
                    Effect.provideService(DbService, db),
                    Effect.catchTag("ParseError", () => badRequest(set)),
                    Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                    Effect.catchTag("PaymentNotInItem", () => paymentNotFound(set)),
                    Effect.catchAllDefect(() => internal(set)),
                  ),
                );
              },
              manualParse,
            )
            .delete(
              "/budget/items/:itemId/payments/:paymentId",
              async ({ weddingId, params, set }) => {
                if (!weddingId) return internalSync(set);
                return runCire(
                  budgetService
                    .removePayment({
                      weddingId,
                      itemId: params.itemId,
                      paymentId: params.paymentId,
                    })
                    .pipe(
                      Effect.map(() => ({ ok: true as const })),
                      Effect.provideService(DbService, db),
                      Effect.catchTag("BudgetItemNotInWedding", () => itemNotFound(set)),
                      Effect.catchTag("PaymentNotInItem", () => paymentNotFound(set)),
                      Effect.catchAllDefect(() => internal(set)),
                    ),
                );
              },
            ),
        )
        // Owner-only cap set — delegates to the settings service (single writer
        // of weddings.budget_total_minor).
        .guard((own) =>
          own.use(weddingOwner(db)).put(
            "/budget/total",
            async ({ weddingId, request, set }) => {
              if (!weddingId) return internalSync(set);
              const raw: unknown = await request.json().catch(() => null);
              return runCire(
                Effect.gen(function* () {
                  const body = yield* Schema.decodeUnknown(SetBudgetTotalBody)(raw);
                  const profile = yield* weddingSettingsService.update(weddingId, {
                    budgetTotalMinor: body.budgetTotalMinor,
                  });
                  return { budgetTotalMinor: profile.budgetTotalMinor };
                }).pipe(
                  Effect.provideService(DbService, db),
                  Effect.catchTag("ParseError", () => badRequest(set)),
                  Effect.catchTag("WeddingNotFound", () => itemNotFound(set)),
                  Effect.catchTag("SettingsWriteError", () => internal(set)),
                  Effect.catchAllDefect(() => internal(set)),
                ),
              );
            },
            manualParse,
          ),
        ),
    );
```

Note: `weddingSettingsService.update` accepts an `UpdateSettingsBody`; passing `{ budgetTotalMinor }` alone is a valid partial patch (PATCH semantics — only that field changes). Confirm the type allows a lone `budgetTotalMinor` key; if `UpdateSettingsBody` is a `Schema.Struct` of all-optional fields, it does.

- [ ] **Step 4: Mount the routes in `app.ts`**

Add the import beside the task-route import (~line 31):

```typescript
import { createBudgetReadRoutes, createBudgetWriteRoutes } from "./routes/budget";
```

Add the two `.use(...)` immediately after the task routes (~line 323):

```typescript
      .use(createTaskReadRoutes(db, osnAuthOptions))
      .use(createTaskWriteRoutes(db, osnAuthOptions))
      .use(createBudgetReadRoutes(db, osnAuthOptions))
      .use(createBudgetWriteRoutes(db, osnAuthOptions))
```

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `bun run --cwd cire/api test -- routes/budget`
Expected: PASS (all cases).

- [ ] **Step 6: Run the whole cire/api suite (guard against a route-ordering or lockstep regression)**

Run: `bun run --cwd cire/api test`
Expected: PASS — including `ddl-lockstep`, tasks, and organiser-rsvp tests.

- [ ] **Step 7: Commit**

```bash
git add cire/api/src/routes/budget.ts cire/api/src/routes/budget.test.ts cire/api/src/app.ts
git commit -m "feat(cire/api): budget routes (member read / editor writes / owner cap)"
```

---

### Task 5: Organiser category mirror + budget-store

**Files:**
- Create: `cire/organiser/src/lib/service-categories.ts`
- Create: `cire/organiser/src/lib/budget-store.ts`
- Test: `cire/organiser/src/lib/budget-store.test.ts`

**Interfaces:**
- Consumes: nothing (plain Solid).
- Produces:
  - `SERVICE_CATEGORIES: readonly {key, label}[]`, `type ServiceCategory` — client label mirror.
  - `interface BudgetItemRow { id, weddingId, category, name, estimateMinor: number|null, quotedMinor: number|null, actualMinor: number|null, notes: string|null, sortOrder, createdAt, updatedAt }`
  - `interface PaymentRow { id, budgetItemId, label, amountMinor: number, dueAt: string|null, paidAt: number|null, createdAt }`
  - `interface BudgetSnapshot { items: BudgetItemRow[]; payments: PaymentRow[]; budgetTotalMinor: number|null; currency: string }`
  - Store fns: `budgetAccessor(weddingId): Accessor<BudgetSnapshot | null>`, `hasCachedBudget`, `setCachedBudget`, `peekCachedBudget`, `invalidateBudget`, `ensureBudgetLoaded(weddingId, fetcher)`, `spentSoFar(weddingId): number | null`, `upcomingPayments(weddingId): PaymentRow[]`, `__resetBudgetCache()`.
  - `itemSpend(item): number` — the `actual ?? quoted ?? estimate ?? 0` rule, mirror of the server's.

- [ ] **Step 1: Write the failing test**

Create `cire/organiser/src/lib/budget-store.test.ts`:

```typescript
import { beforeEach, describe, expect, it } from "vitest";

import {
  __resetBudgetCache,
  type BudgetItemRow,
  type BudgetSnapshot,
  budgetAccessor,
  ensureBudgetLoaded,
  type PaymentRow,
  spentSoFar,
  upcomingPayments,
} from "./budget-store";

const item = (over: Partial<BudgetItemRow>): BudgetItemRow => ({
  id: "bit_1",
  weddingId: "wed_1",
  category: "venue",
  name: "Venue",
  estimateMinor: null,
  quotedMinor: null,
  actualMinor: null,
  notes: null,
  sortOrder: 0,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const payment = (over: Partial<PaymentRow>): PaymentRow => ({
  id: "pay_1",
  budgetItemId: "bit_1",
  label: "Deposit",
  amountMinor: 1000,
  dueAt: null,
  paidAt: null,
  createdAt: 1,
  ...over,
});

const snap = (over: Partial<BudgetSnapshot>): BudgetSnapshot => ({
  items: [],
  payments: [],
  budgetTotalMinor: null,
  currency: "AUD",
  ...over,
});

beforeEach(() => __resetBudgetCache());

describe("budget-store", () => {
  it("loads once and reuses the cache", async () => {
    let calls = 0;
    const fetcher = async () => {
      calls += 1;
      return snap({ items: [item({})] });
    };
    await ensureBudgetLoaded("wed_1", fetcher);
    await ensureBudgetLoaded("wed_1", fetcher);
    expect(calls).toBe(1);
    expect(budgetAccessor("wed_1")()?.items.length).toBe(1);
  });

  it("spentSoFar uses actual ?? quoted ?? estimate, null before load", async () => {
    expect(spentSoFar("wed_1")).toBeNull();
    await ensureBudgetLoaded("wed_1", async () =>
      snap({
        items: [
          item({ id: "a", estimateMinor: 1000, quotedMinor: 1200, actualMinor: 1250 }),
          item({ id: "b", estimateMinor: 1800 }),
        ],
      }),
    );
    expect(spentSoFar("wed_1")).toBe(1250 + 1800);
  });

  it("upcomingPayments returns only unpaid, earliest due first", async () => {
    await ensureBudgetLoaded("wed_1", async () =>
      snap({
        payments: [
          payment({ id: "p1", dueAt: "2026-08-15", paidAt: null }),
          payment({ id: "p2", dueAt: "2026-03-01", paidAt: null }),
          payment({ id: "p3", dueAt: "2026-01-01", paidAt: 5 }), // paid → excluded
        ],
      }),
    );
    expect(upcomingPayments("wed_1").map((p) => p.id)).toEqual(["p2", "p1"]);
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/organiser test -- budget-store`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the category mirror**

Create `cire/organiser/src/lib/service-categories.ts`:

```typescript
// Client mirror of the server's service-category list
// (cire/api/src/lib/service-categories.ts). The organiser can't import cire/api,
// so the labels + order live here too — keep the two in sync when a category is
// added or a label reworded ([[platform-plan]] §4.3).
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

export function categoryLabel(key: string): string {
  return SERVICE_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}
```

- [ ] **Step 4: Write the store**

Create `cire/organiser/src/lib/budget-store.ts`:

```typescript
// A `weddingId`-keyed cache for the organiser's budget — sibling of
// `tasks-store.ts`/`guests-store.ts`. Fetch-lift so switching modules doesn't
// refetch, and so the Overview budget widget + the Budget view share ONE fetch.
// Effect is deliberately NOT imported (frontend code). Money is minor units.
import { type Accessor, createSignal, type Setter } from "solid-js";

export interface BudgetItemRow {
  id: string;
  weddingId: string;
  category: string;
  name: string;
  estimateMinor: number | null;
  quotedMinor: number | null;
  actualMinor: number | null;
  notes: string | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentRow {
  id: string;
  budgetItemId: string;
  label: string;
  amountMinor: number;
  dueAt: string | null;
  paidAt: number | null;
  createdAt: number;
}

/** The whole budget as the organiser API returns it in one GET. */
export interface BudgetSnapshot {
  items: BudgetItemRow[];
  payments: PaymentRow[];
  budgetTotalMinor: number | null;
  currency: string;
}

interface CacheEntry {
  snapshot: Accessor<BudgetSnapshot | null>;
  setSnapshot: Setter<BudgetSnapshot | null>;
}

const cache = new Map<string, CacheEntry>();

function entryFor(weddingId: string): CacheEntry {
  let entry = cache.get(weddingId);
  if (!entry) {
    const [snapshot, setSnapshot] = createSignal<BudgetSnapshot | null>(null);
    entry = { snapshot, setSnapshot };
    cache.set(weddingId, entry);
  }
  return entry;
}

/** The `actual ?? quoted ?? estimate ?? 0` spend rule — mirror of the server's
 *  computeRollup so an optimistic edit reflects instantly. */
export function itemSpend(item: BudgetItemRow): number {
  return item.actualMinor ?? item.quotedMinor ?? item.estimateMinor ?? 0;
}

export function budgetAccessor(weddingId: string): Accessor<BudgetSnapshot | null> {
  return entryFor(weddingId).snapshot;
}

export function hasCachedBudget(weddingId: string): boolean {
  return cache.get(weddingId)?.snapshot() != null;
}

export function setCachedBudget(weddingId: string, snapshot: BudgetSnapshot): void {
  entryFor(weddingId).setSnapshot(snapshot);
}

export function peekCachedBudget(weddingId: string): BudgetSnapshot | null {
  return cache.get(weddingId)?.snapshot() ?? null;
}

export function invalidateBudget(weddingId: string): void {
  cache.delete(weddingId);
}

/** Reactive spend-so-far for the Overview widget: `null` until first load. */
export function spentSoFar(weddingId: string): number | null {
  const snap = entryFor(weddingId).snapshot();
  if (snap == null) return null;
  return snap.items.reduce((sum, it) => sum + itemSpend(it), 0);
}

/** Unpaid payments, earliest `due_at` first (nulls last). Reactive; `[]` until
 *  load. The Overview flags overdue rows against today. */
export function upcomingPayments(weddingId: string): PaymentRow[] {
  const snap = entryFor(weddingId).snapshot();
  if (snap == null) return [];
  return snap.payments
    .filter((p) => p.paidAt == null)
    .sort((a, b) => {
      if (a.dueAt == null) return b.dueAt == null ? 0 : 1;
      if (b.dueAt == null) return -1;
      return a.dueAt < b.dueAt ? -1 : a.dueAt > b.dueAt ? 1 : 0;
    });
}

const inflight = new Map<string, Promise<void>>();

export function ensureBudgetLoaded(
  weddingId: string,
  fetcher: () => Promise<BudgetSnapshot>,
): Promise<void> {
  if (hasCachedBudget(weddingId)) return Promise.resolve();
  let pending = inflight.get(weddingId);
  if (!pending) {
    pending = fetcher()
      .then((snap) => {
        setCachedBudget(weddingId, snap);
      })
      .finally(() => inflight.delete(weddingId));
    inflight.set(weddingId, pending);
  }
  return pending;
}

/** Test-only: clear the whole cache so each test starts cold. */
export function __resetBudgetCache(): void {
  cache.clear();
  inflight.clear();
}
```

- [ ] **Step 5: Run the test — verify it PASSES**

Run: `bun run --cwd cire/organiser test -- budget-store`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add cire/organiser/src/lib/service-categories.ts cire/organiser/src/lib/budget-store.ts cire/organiser/src/lib/budget-store.test.ts
git commit -m "feat(cire/organiser): service-category mirror + budget-store cache"
```

---

### Task 6: BudgetView component

**Files:**
- Create: `cire/organiser/src/components/BudgetView.tsx`
- Test: `cire/organiser/src/components/BudgetView.test.tsx`

**Interfaces:**
- Consumes: `SERVICE_CATEGORIES`, `categoryLabel`, `type ServiceCategory` (Task 5); budget-store fns + types + `itemSpend` (Task 5); `apiUrl`, `isAuthExpired`, `redirectToLogin` from `../lib/api`; `useAuth` from `@osn/client/solid`.
- Produces: `export default function BudgetView(props: { weddingId: string; canEdit?: boolean; canManage?: boolean })`.
  - `canEdit` → editor writes (add/edit item, payments, reorder). `canManage` → owner-only cap editor (mirrors `ModuleShell`'s `canManage` used by invite/codes).

**Behaviour:** load-once via the store; a summary header (spent vs cap, owner cap editor); an add-item form (editor); category-grouped sections (only categories with items) each with an estimate/actual subtotal; per item the three money figures inline-editable (PATCH on change), expandable payment rows (add / mark-paid / delete), within-category move up/down, and delete. All writes optimistic against the cache, reload on failure. A money helper formats minor→major with the snapshot currency.

- [ ] **Step 1: Write the failing test**

Create `cire/organiser/src/components/BudgetView.test.tsx`:

```typescript
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetBudgetCache,
  type BudgetSnapshot,
  setCachedBudget,
} from "../lib/budget-store";
import BudgetView from "./BudgetView";

const authFetch = vi.fn();
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

const snap = (over: Partial<BudgetSnapshot>): BudgetSnapshot => ({
  items: [],
  payments: [],
  budgetTotalMinor: null,
  currency: "AUD",
  ...over,
});

beforeEach(() => {
  __resetBudgetCache();
  authFetch.mockReset();
});

describe("BudgetView", () => {
  it("groups items under their category headings with a subtotal", async () => {
    setCachedBudget("wed_1", snap({
      items: [{
        id: "a", weddingId: "wed_1", category: "venue", name: "Reception venue",
        estimateMinor: 1200000, quotedMinor: null, actualMinor: null, notes: null,
        sortOrder: 0, createdAt: 1, updatedAt: 1,
      }],
    }));
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    expect(await screen.findByText("Reception venue")).toBeInTheDocument();
    expect(screen.getByText("Venue")).toBeInTheDocument();
  });

  it("hides the add-item form for a viewer (read-only)", async () => {
    setCachedBudget("wed_1", snap({
      items: [{
        id: "a", weddingId: "wed_1", category: "venue", name: "Reception venue",
        estimateMinor: null, quotedMinor: null, actualMinor: null, notes: null,
        sortOrder: 0, createdAt: 1, updatedAt: 1,
      }],
    }));
    render(() => <BudgetView weddingId="wed_1" canEdit={false} canManage={false} />);
    await screen.findByText("Reception venue");
    expect(screen.queryByRole("button", { name: /add item/i })).not.toBeInTheDocument();
  });

  it("adds an item (POST) and appends it to the cache", async () => {
    setCachedBudget("wed_1", snap({ items: [] }));
    authFetch.mockResolvedValueOnce(
      new Response(JSON.stringify({
        item: {
          id: "new", weddingId: "wed_1", category: "catering", name: "Caterer",
          estimateMinor: null, quotedMinor: null, actualMinor: null, notes: null,
          sortOrder: 0, createdAt: 2, updatedAt: 2,
        },
      }), { status: 200 }),
    );
    render(() => <BudgetView weddingId="wed_1" canEdit={true} canManage={true} />);
    const nameInput = await screen.findByPlaceholderText(/caterer, venue/i);
    fireEvent.input(nameInput, { target: { value: "Caterer" } });
    fireEvent.click(screen.getByRole("button", { name: /add item/i }));
    await waitFor(() => expect(authFetch).toHaveBeenCalledTimes(1));
    const [url, init] = authFetch.mock.calls[0]!;
    expect(String(url)).toMatch(/\/budget\/items$/);
    expect(init.method).toBe("POST");
    expect(await screen.findByText("Caterer")).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/organiser test -- BudgetView`
Expected: FAIL — component not found.

- [ ] **Step 3: Write the component**

Create `cire/organiser/src/components/BudgetView.tsx`:

```typescript
import { useAuth } from "@osn/client/solid";
import { createMemo, createSignal, For, onMount, Show } from "solid-js";

import { apiUrl, isAuthExpired, redirectToLogin } from "../lib/api";
import { categoryLabel, SERVICE_CATEGORIES, type ServiceCategory } from "../lib/service-categories";
import {
  type BudgetItemRow,
  type BudgetSnapshot,
  budgetAccessor,
  ensureBudgetLoaded,
  invalidateBudget,
  itemSpend,
  type PaymentRow,
  peekCachedBudget,
  setCachedBudget,
} from "../lib/budget-store";

interface BudgetViewProps {
  weddingId: string;
  /** Owner/editor may add/edit items + payments and reorder. */
  canEdit?: boolean;
  /** Owner-only: edit the overall budget cap. */
  canManage?: boolean;
}

/** Format minor units as major with the wedding currency, e.g. 1250000 → "$12,500.00".
 *  Uses Intl with the ISO currency; falls back to a plain number if unknown. */
function fmtMinor(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}

export default function BudgetView(props: BudgetViewProps) {
  const { authFetch } = useAuth();
  const snapshot = budgetAccessor(props.weddingId);
  const [error, setError] = createSignal<string | null>(null);
  const [newCategory, setNewCategory] = createSignal<ServiceCategory>(SERVICE_CATEGORIES[0]!.key);
  const [newName, setNewName] = createSignal("");
  const [newEstimate, setNewEstimate] = createSignal("");
  const [expanded, setExpanded] = createSignal<string | null>(null);

  const budgetUrl = () => apiUrl(`/api/organiser/weddings/${props.weddingId}/budget`);
  const currency = () => snapshot()?.currency ?? "AUD";

  const load = async (): Promise<BudgetSnapshot> => {
    const res = await authFetch(budgetUrl());
    if (res.status === 401) {
      redirectToLogin();
      return { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" };
    }
    if (!res.ok) throw new Error(`Failed to load budget (${res.status})`);
    return (await res.json()) as BudgetSnapshot;
  };

  onMount(() => {
    ensureBudgetLoaded(props.weddingId, load).catch((err) => {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't load your budget. Refresh to try again.");
    });
  });

  const reload = async () => {
    invalidateBudget(props.weddingId);
    try {
      setCachedBudget(props.weddingId, await load());
    } catch (err) {
      if (isAuthExpired(err)) return redirectToLogin();
      setError("Couldn't refresh your budget.");
    }
  };

  // Convenience: mutate the cached snapshot with a producer.
  const patchSnap = (fn: (s: BudgetSnapshot) => BudgetSnapshot) => {
    const cur = peekCachedBudget(props.weddingId);
    if (cur) setCachedBudget(props.weddingId, fn(cur));
  };

  // Items grouped by category — only categories that have items, in enum order.
  const grouped = createMemo(() => {
    const items = snapshot()?.items ?? [];
    return SERVICE_CATEGORIES.map((c) => ({
      category: c,
      items: items.filter((it) => it.category === c.key).sort((a, b) => a.sortOrder - b.sortOrder),
    })).filter((g) => g.items.length > 0);
  });

  const paymentsFor = (itemId: string): PaymentRow[] =>
    (snapshot()?.payments ?? []).filter((p) => p.budgetItemId === itemId);

  const spent = createMemo(() => {
    const items = snapshot()?.items ?? [];
    return items.reduce((sum, it) => sum + itemSpend(it), 0);
  });

  // ── Item writes ──────────────────────────────────────────────────────────
  const addItem = async (e: Event) => {
    e.preventDefault();
    const name = newName().trim();
    if (!name) return;
    setError(null);
    const estMinor = newEstimate().trim() === "" ? null : Math.round(Number(newEstimate()) * 100);
    if (estMinor !== null && (!Number.isFinite(estMinor) || estMinor < 0)) {
      setError("Estimate must be a positive amount.");
      return;
    }
    const body = { category: newCategory(), name, estimateMinor: estMinor };
    setNewName("");
    setNewEstimate("");
    try {
      const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items`), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`create ${res.status}`);
      const { item } = (await res.json()) as { item: BudgetItemRow };
      patchSnap((s) => ({ ...s, items: [...s.items, item] }));
    } catch {
      setError("Couldn't add that item.");
      void reload();
    }
  };

  const patchItemMoney = async (
    item: BudgetItemRow,
    field: "estimateMinor" | "quotedMinor" | "actualMinor",
    raw: string,
  ) => {
    const minor = raw.trim() === "" ? null : Math.round(Number(raw) * 100);
    if (minor !== null && (!Number.isFinite(minor) || minor < 0)) {
      setError("Amounts must be positive.");
      return;
    }
    // Optimistic.
    patchSnap((s) => ({
      ...s,
      items: s.items.map((it) => (it.id === item.id ? { ...it, [field]: minor } : it)),
    }));
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ [field]: minor }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`patch ${res.status}`);
      const { item: updated } = (await res.json()) as { item: BudgetItemRow };
      patchSnap((s) => ({
        ...s,
        items: s.items.map((it) => (it.id === updated.id ? updated : it)),
      }));
    } catch {
      setError("Couldn't save that amount.");
      void reload();
    }
  };

  const deleteItem = async (item: BudgetItemRow) => {
    patchSnap((s) => ({
      ...s,
      items: s.items.filter((it) => it.id !== item.id),
      payments: s.payments.filter((p) => p.budgetItemId !== item.id),
    }));
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}`),
        { method: "DELETE" },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete ${res.status}`);
    } catch {
      setError("Couldn't delete that item.");
      void reload();
    }
  };

  const move = async (category: ServiceCategory, index: number, delta: -1 | 1) => {
    const items = (peekCachedBudget(props.weddingId)?.items ?? [])
      .filter((it) => it.category === category)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    const target = index + delta;
    if (target < 0 || target >= items.length) return;
    const reordered = [...items];
    const [moved] = reordered.splice(index, 1);
    reordered.splice(target, 0, moved!);
    const orderedIds = reordered.map((it) => it.id);
    const bySort = new Map(orderedIds.map((id, i) => [id, i]));
    patchSnap((s) => ({
      ...s,
      items: s.items.map((it) =>
        it.category === category ? { ...it, sortOrder: bySort.get(it.id) ?? it.sortOrder } : it,
      ),
    }));
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items/reorder`),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ category, orderedIds }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`reorder ${res.status}`);
    } catch {
      setError("Couldn't save the new order.");
      void reload();
    }
  };

  // ── Payment writes ───────────────────────────────────────────────────────
  const addPayment = async (item: BudgetItemRow, label: string, amountText: string, dueAt: string) => {
    const amount = Math.round(Number(amountText) * 100);
    if (!label.trim() || !Number.isFinite(amount) || amount < 0) {
      setError("A payment needs a label and a positive amount.");
      return;
    }
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}/payments`),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: label.trim(), amountMinor: amount, dueAt: dueAt || null }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`payment ${res.status}`);
      const { payment } = (await res.json()) as { payment: PaymentRow };
      patchSnap((s) => ({ ...s, payments: [...s.payments, payment] }));
    } catch {
      setError("Couldn't add that payment.");
      void reload();
    }
  };

  const togglePaid = async (item: BudgetItemRow, payment: PaymentRow) => {
    const paid = payment.paidAt == null;
    patchSnap((s) => ({
      ...s,
      payments: s.payments.map((p) =>
        p.id === payment.id ? { ...p, paidAt: paid ? Date.now() : null } : p,
      ),
    }));
    try {
      const res = await authFetch(
        apiUrl(
          `/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}/payments/${payment.id}`,
        ),
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ paid }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`patch payment ${res.status}`);
      const { payment: updated } = (await res.json()) as { payment: PaymentRow };
      patchSnap((s) => ({
        ...s,
        payments: s.payments.map((p) => (p.id === updated.id ? updated : p)),
      }));
    } catch {
      setError("Couldn't update that payment.");
      void reload();
    }
  };

  const deletePayment = async (item: BudgetItemRow, payment: PaymentRow) => {
    patchSnap((s) => ({ ...s, payments: s.payments.filter((p) => p.id !== payment.id) }));
    try {
      const res = await authFetch(
        apiUrl(
          `/api/organiser/weddings/${props.weddingId}/budget/items/${item.id}/payments/${payment.id}`,
        ),
        { method: "DELETE" },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`delete payment ${res.status}`);
    } catch {
      setError("Couldn't delete that payment.");
      void reload();
    }
  };

  // ── Cap (owner only) ─────────────────────────────────────────────────────
  const [capDraft, setCapDraft] = createSignal<string | null>(null);
  const saveCap = async () => {
    const draft = capDraft();
    if (draft == null) return;
    const minor = draft.trim() === "" ? null : Math.round(Number(draft) * 100);
    if (minor !== null && (!Number.isFinite(minor) || minor < 0)) {
      setError("Budget must be a positive amount.");
      return;
    }
    patchSnap((s) => ({ ...s, budgetTotalMinor: minor }));
    setCapDraft(null);
    try {
      const res = await authFetch(
        apiUrl(`/api/organiser/weddings/${props.weddingId}/budget/total`),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ budgetTotalMinor: minor }),
        },
      );
      if (res.status === 401) return redirectToLogin();
      if (!res.ok) throw new Error(`cap ${res.status}`);
    } catch {
      setError("Couldn't save the budget total.");
      void reload();
    }
  };

  return (
    <div class="flex flex-col gap-6">
      <Show when={error()}>
        <p class="border-error/40 text-error rounded-sm border px-3 py-2 text-[0.82rem]">{error()}</p>
      </Show>

      {/* Summary — spent vs cap, owner cap editor. */}
      <div class="border-border bg-surface/20 flex flex-wrap items-center justify-between gap-4 rounded-sm border p-4">
        <div class="flex flex-col gap-1">
          <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
            Spent so far
          </span>
          <span class="text-text text-[1.2rem] font-semibold">
            {fmtMinor(spent(), currency())}
            <Show when={snapshot()?.budgetTotalMinor != null}>
              <span class="text-text-muted text-[0.9rem] font-normal">
                {" "}of {fmtMinor(snapshot()!.budgetTotalMinor!, currency())}
              </span>
            </Show>
          </span>
          <Show
            when={
              snapshot()?.budgetTotalMinor != null && spent() > (snapshot()?.budgetTotalMinor ?? 0)
            }
          >
            <span class="text-error text-[0.75rem]">Over budget</span>
          </Show>
        </div>
        <Show when={props.canManage}>
          <Show
            when={capDraft() !== null}
            fallback={
              <button
                type="button"
                onClick={() =>
                  setCapDraft(
                    snapshot()?.budgetTotalMinor == null
                      ? ""
                      : (snapshot()!.budgetTotalMinor! / 100).toString(),
                  )
                }
                class="text-gold-dim hover:text-gold text-[0.78rem] underline-offset-4 hover:underline"
              >
                {snapshot()?.budgetTotalMinor == null ? "Set a budget →" : "Edit budget"}
              </button>
            }
          >
            <div class="flex items-end gap-2">
              <label class="flex flex-col gap-1">
                <span class="text-gold-dim font-body text-[0.66rem] tracking-[0.16em] uppercase">
                  Total budget ({currency()})
                </span>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={capDraft() ?? ""}
                  onInput={(e) => setCapDraft(e.currentTarget.value)}
                  class="border-border bg-bg text-text w-32 rounded-sm border px-3 py-2 text-[0.9rem]"
                />
              </label>
              <button
                type="button"
                onClick={saveCap}
                class="bg-gold text-bg rounded-sm px-3 py-2 text-[0.78rem] tracking-[0.08em] uppercase"
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setCapDraft(null)}
                class="text-text-muted hover:text-text px-2 py-2 text-[0.78rem]"
              >
                Cancel
              </button>
            </div>
          </Show>
        </Show>
      </div>

      {/* Add item (editor). */}
      <Show when={props.canEdit}>
        <form
          onSubmit={addItem}
          class="border-border bg-surface/20 flex flex-wrap items-end gap-3 rounded-sm border p-4"
        >
          <label class="flex flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              Category
            </span>
            <select
              value={newCategory()}
              onChange={(e) => setNewCategory(e.currentTarget.value as ServiceCategory)}
              class="border-border bg-bg text-text rounded-sm border px-3 py-2 text-[0.9rem]"
            >
              <For each={SERVICE_CATEGORIES}>{(c) => <option value={c.key}>{c.label}</option>}</For>
            </select>
          </label>
          <label class="flex min-w-[12rem] flex-1 flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              Item
            </span>
            <input
              type="text"
              value={newName()}
              onInput={(e) => setNewName(e.currentTarget.value)}
              placeholder="Caterer, venue, band…"
              class="border-border bg-bg text-text rounded-sm border px-3 py-2 text-[0.9rem]"
            />
          </label>
          <label class="flex flex-col gap-1">
            <span class="text-gold-dim font-body text-[0.68rem] tracking-[0.16em] uppercase">
              Estimate (optional)
            </span>
            <input
              type="number"
              min="0"
              step="0.01"
              value={newEstimate()}
              onInput={(e) => setNewEstimate(e.currentTarget.value)}
              class="border-border bg-bg text-text w-32 rounded-sm border px-3 py-2 text-[0.9rem]"
            />
          </label>
          <button
            type="submit"
            class="bg-gold text-bg rounded-sm px-4 py-2 text-[0.82rem] tracking-[0.08em] uppercase"
          >
            Add item
          </button>
        </form>
      </Show>

      <Show
        when={grouped().length > 0}
        fallback={<p class="text-text-muted text-[0.85rem] italic">No budget items yet.</p>}
      >
        <For each={grouped()}>
          {(group) => {
            const subtotalEst = () =>
              group.items.reduce((s, it) => s + (it.estimateMinor ?? 0), 0);
            const subtotalActual = () => group.items.reduce((s, it) => s + itemSpend(it), 0);
            return (
              <section class="flex flex-col gap-2">
                <div class="flex items-baseline justify-between">
                  <h3 class="text-gold-dim font-body text-[0.7rem] tracking-[0.18em] uppercase">
                    {categoryLabel(group.category.key)}
                  </h3>
                  <span class="text-text-muted text-[0.75rem]">
                    est {fmtMinor(subtotalEst(), currency())} · spent{" "}
                    {fmtMinor(subtotalActual(), currency())}
                  </span>
                </div>
                <ul class="flex flex-col gap-1">
                  <For each={group.items}>
                    {(item, i) => (
                      <li class="border-border bg-surface/10 flex flex-col gap-2 rounded-sm border px-3 py-2">
                        <div class="flex flex-wrap items-center gap-3">
                          <span class="text-text min-w-[8rem] flex-1 text-[0.9rem]">{item.name}</span>
                          <MoneyCell
                            label="Est"
                            minor={item.estimateMinor}
                            currency={currency()}
                            canEdit={props.canEdit}
                            onCommit={(raw) => patchItemMoney(item, "estimateMinor", raw)}
                          />
                          <MoneyCell
                            label="Quote"
                            minor={item.quotedMinor}
                            currency={currency()}
                            canEdit={props.canEdit}
                            onCommit={(raw) => patchItemMoney(item, "quotedMinor", raw)}
                          />
                          <MoneyCell
                            label="Actual"
                            minor={item.actualMinor}
                            currency={currency()}
                            canEdit={props.canEdit}
                            onCommit={(raw) => patchItemMoney(item, "actualMinor", raw)}
                          />
                          <button
                            type="button"
                            onClick={() => setExpanded(expanded() === item.id ? null : item.id)}
                            class="text-text-muted hover:text-text px-1 text-[0.78rem]"
                          >
                            payments ({paymentsFor(item.id).length})
                          </button>
                          <Show when={props.canEdit}>
                            <div class="flex items-center gap-1">
                              <button
                                type="button"
                                aria-label="Move up"
                                disabled={i() === 0}
                                onClick={() => move(group.category.key, i(), -1)}
                                class="text-text-muted hover:text-text px-1 disabled:opacity-30"
                              >
                                ↑
                              </button>
                              <button
                                type="button"
                                aria-label="Move down"
                                disabled={i() === group.items.length - 1}
                                onClick={() => move(group.category.key, i(), 1)}
                                class="text-text-muted hover:text-text px-1 disabled:opacity-30"
                              >
                                ↓
                              </button>
                              <button
                                type="button"
                                aria-label="Delete item"
                                onClick={() => deleteItem(item)}
                                class="text-text-muted hover:text-error px-1"
                              >
                                ✕
                              </button>
                            </div>
                          </Show>
                        </div>
                        <Show when={expanded() === item.id}>
                          <PaymentPanel
                            item={item}
                            payments={paymentsFor(item.id)}
                            currency={currency()}
                            canEdit={props.canEdit}
                            onAdd={addPayment}
                            onTogglePaid={togglePaid}
                            onDelete={deletePayment}
                          />
                        </Show>
                      </li>
                    )}
                  </For>
                </ul>
              </section>
            );
          }}
        </For>
      </Show>
    </div>
  );
}

/** One editable money figure. Read-only shows the formatted value or "—";
 *  editable renders a number input committing on change. */
function MoneyCell(props: {
  label: string;
  minor: number | null;
  currency: string;
  canEdit?: boolean;
  onCommit: (raw: string) => void;
}) {
  return (
    <label class="flex flex-col gap-0.5">
      <span class="text-gold-dim font-body text-[0.58rem] tracking-[0.14em] uppercase">
        {props.label}
      </span>
      <Show
        when={props.canEdit}
        fallback={
          <span class="text-text text-[0.85rem]">
            {props.minor == null ? "—" : fmtMinor(props.minor, props.currency)}
          </span>
        }
      >
        <input
          type="number"
          min="0"
          step="0.01"
          value={props.minor == null ? "" : (props.minor / 100).toString()}
          onChange={(e) => props.onCommit(e.currentTarget.value)}
          class="border-border bg-bg text-text w-24 rounded-sm border px-2 py-1 text-[0.82rem]"
        />
      </Show>
    </label>
  );
}

/** The expandable payment schedule for one item. */
function PaymentPanel(props: {
  item: BudgetItemRow;
  payments: PaymentRow[];
  currency: string;
  canEdit?: boolean;
  onAdd: (item: BudgetItemRow, label: string, amount: string, dueAt: string) => void;
  onTogglePaid: (item: BudgetItemRow, payment: PaymentRow) => void;
  onDelete: (item: BudgetItemRow, payment: PaymentRow) => void;
}) {
  const [label, setLabel] = createSignal("");
  const [amount, setAmount] = createSignal("");
  const [due, setDue] = createSignal("");
  const submit = (e: Event) => {
    e.preventDefault();
    props.onAdd(props.item, label(), amount(), due());
    setLabel("");
    setAmount("");
    setDue("");
  };
  return (
    <div class="border-border/60 ml-2 flex flex-col gap-2 border-l pl-3">
      <For each={props.payments}>
        {(p) => (
          <div class="flex flex-wrap items-center gap-2 text-[0.82rem]">
            <input
              type="checkbox"
              aria-label={`${p.label} paid`}
              checked={p.paidAt != null}
              disabled={!props.canEdit}
              onChange={() => props.canEdit && props.onTogglePaid(props.item, p)}
            />
            <span class="text-text flex-1">
              {p.label} · {fmtMinor(p.amountMinor, props.currency)}
              <Show when={p.dueAt}>
                <span class="text-text-muted"> · due {p.dueAt}</span>
              </Show>
              <Show when={p.paidAt != null}>
                <span class="text-gold-dim"> · paid</span>
              </Show>
            </span>
            <Show when={props.canEdit}>
              <button
                type="button"
                aria-label="Delete payment"
                onClick={() => props.onDelete(props.item, p)}
                class="text-text-muted hover:text-error px-1"
              >
                ✕
              </button>
            </Show>
          </div>
        )}
      </For>
      <Show when={props.canEdit}>
        <form onSubmit={submit} class="flex flex-wrap items-end gap-2">
          <input
            type="text"
            value={label()}
            onInput={(e) => setLabel(e.currentTarget.value)}
            placeholder="Deposit"
            class="border-border bg-bg text-text w-28 rounded-sm border px-2 py-1 text-[0.8rem]"
          />
          <input
            type="number"
            min="0"
            step="0.01"
            value={amount()}
            onInput={(e) => setAmount(e.currentTarget.value)}
            placeholder="Amount"
            class="border-border bg-bg text-text w-24 rounded-sm border px-2 py-1 text-[0.8rem]"
          />
          <input
            type="date"
            value={due()}
            onInput={(e) => setDue(e.currentTarget.value)}
            class="border-border bg-bg text-text rounded-sm border px-2 py-1 text-[0.8rem]"
          />
          <button
            type="submit"
            class="border-gold/40 text-gold-dim hover:bg-gold/10 rounded-sm border px-2 py-1 text-[0.75rem]"
          >
            Add payment
          </button>
        </form>
      </Show>
    </div>
  );
}
```

- [ ] **Step 4: Run the test — verify it PASSES**

Run: `bun run --cwd cire/organiser test -- BudgetView`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add cire/organiser/src/components/BudgetView.tsx cire/organiser/src/components/BudgetView.test.tsx
git commit -m "feat(cire/organiser): BudgetView (category items, payments, cap editor)"
```

---

### Task 7: Wire `budget` into the module IA

**Files:**
- Modify: `cire/organiser/src/lib/dashboard-route.ts` (`MODULES`, `MODULE_SUBS`)
- Modify: `cire/organiser/src/components/ModuleSidebar.tsx` (`MODULE_NAV`)
- Modify: `cire/organiser/src/components/ModuleShell.tsx` (import + render branch)
- Test: `cire/organiser/src/lib/dashboard-route.test.ts` (extend existing)

**Interfaces:**
- Consumes: `BudgetView` (Task 6).
- Produces: `"budget"` is a valid `Module`; `#/w/<id>/budget` parses to it; the sidebar shows it; the shell renders `BudgetView` with `canEdit` + `canManage`.

- [ ] **Step 1: Write the failing test**

Add to `cire/organiser/src/lib/dashboard-route.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

import { isModule, MODULES, parseRoute, serializeRoute } from "./dashboard-route";

describe("budget module route", () => {
  it("budget is a known module", () => {
    expect(isModule("budget")).toBe(true);
    expect(MODULES).toContain("budget");
  });

  it("parses #/w/<id>/budget to the budget module", () => {
    const r = parseRoute("#/w/wed_1/budget");
    expect(r.view).toBe("weddings");
    if (r.view === "weddings") {
      expect(r.weddingId).toBe("wed_1");
      expect(r.module).toBe("budget");
    }
  });

  it("serializes a budget route back to the canonical hash", () => {
    expect(
      serializeRoute({ view: "weddings", weddingId: "wed_1", module: "budget", sub: "index" }),
    ).toBe("#/w/wed_1/budget");
  });
});
```

- [ ] **Step 2: Run the test — verify it FAILS**

Run: `bun run --cwd cire/organiser test -- dashboard-route`
Expected: FAIL — `isModule("budget")` is false.

- [ ] **Step 3: Register the module in `dashboard-route.ts`**

Add `"budget"` to `MODULES` after `checklist` (sidebar order — planning tools sit together):

```typescript
export const MODULES = [
  "overview",
  "schedule",
  "checklist",
  "budget",
  "guests",
  "invite",
  "settings",
] as const;
```

Add its single implicit sub to `MODULE_SUBS` (after the `checklist` line):

```typescript
  checklist: ["index"],
  budget: ["index"],
```

- [ ] **Step 4: Add the sidebar entry in `ModuleSidebar.tsx`**

Add to `MODULE_NAV`, immediately after the `checklist` row (line 21):

```typescript
  { id: "budget", label: "Budget", glyph: "$", hint: "Estimates, quotes, and payments" },
```

- [ ] **Step 5: Render the module in `ModuleShell.tsx`**

Add the import beside the others (near line 4):

```typescript
import BudgetView from "./BudgetView";
```

Add the render branch after the Checklist block (~line 167). `canManage` gates the owner cap editor (the same prop the invite/codes owner surface uses):

```tsx
        {/* ── Budget: per-category items + payments ────────────────────── */}
        <Show when={props.module === "budget"}>
          <BudgetView
            weddingId={props.weddingId}
            canEdit={props.canEdit}
            canManage={props.canManage}
          />
        </Show>
```

- [ ] **Step 6: Run the test — verify it PASSES**

Run: `bun run --cwd cire/organiser test -- dashboard-route`
Expected: PASS.

- [ ] **Step 7: Type-check the organiser package (the `Module` union widened)**

Run: `bun run check`
Expected: PASS — no missing-case errors. (The `onNavigate` union in `Overview.tsx` gains `"budget"` in Task 8.)

- [ ] **Step 8: Commit**

```bash
git add cire/organiser/src/lib/dashboard-route.ts cire/organiser/src/lib/dashboard-route.test.ts cire/organiser/src/components/ModuleSidebar.tsx cire/organiser/src/components/ModuleShell.tsx
git commit -m "feat(cire/organiser): register budget module in the IA shell"
```

---

### Task 8: Live budget Overview widget + move the cap out of Settings

**Files:**
- Modify: `cire/organiser/src/components/Overview.tsx` (replace the Budget `SnapshotComingSoon`; widen `onNavigate`; fetch-lift budget)
- Modify: `cire/organiser/src/components/SettingsPanel.tsx` (remove the budget input — it moved to the Budget tab)
- Test: `cire/organiser/src/components/Overview.budget.test.tsx`
- Test: `cire/organiser/src/components/SettingsPanel.test.tsx` (adjust — assert the budget field is gone)

**Interfaces:**
- Consumes: `ensureBudgetLoaded`, `spentSoFar`, `upcomingPayments`, `type BudgetSnapshot` (Task 5).
- Produces: the Overview Budget card shows live spend-vs-cap + the next unpaid payments; the Settings Profile form no longer edits the cap.

- [ ] **Step 1: Write the failing tests**

Create `cire/organiser/src/components/Overview.budget.test.tsx`:

```typescript
import { render, screen } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { __resetBudgetCache, type BudgetSnapshot, setCachedBudget } from "../lib/budget-store";
import Overview from "./Overview";

const authFetch = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
vi.mock("@osn/client/solid", () => ({ useAuth: () => ({ authFetch }) }));

const snap = (over: Partial<BudgetSnapshot>): BudgetSnapshot => ({
  items: [],
  payments: [],
  budgetTotalMinor: null,
  currency: "AUD",
  ...over,
});

beforeEach(() => {
  __resetBudgetCache();
  authFetch.mockClear();
});

describe("Overview budget widget", () => {
  it("shows live spend once the budget is cached", async () => {
    setCachedBudget("wed_1", snap({
      budgetTotalMinor: 4500000,
      items: [{
        id: "a", weddingId: "wed_1", category: "venue", name: "Venue",
        estimateMinor: null, quotedMinor: null, actualMinor: 1700000, notes: null,
        sortOrder: 0, createdAt: 1, updatedAt: 1,
      }],
    }));
    render(() => <Overview weddingId="wed_1" onNavigate={() => {}} />);
    // "$17,000.00 of $45,000.00" surfaces on the Budget card.
    expect(await screen.findByText(/of \$45,000/)).toBeInTheDocument();
  });
});
```

In `cire/organiser/src/components/SettingsPanel.test.tsx`, add a case asserting the budget input is gone (place beside the existing profile-field assertions):

```typescript
  it("no longer renders a budget field (moved to the Budget tab)", async () => {
    // Render the panel as the existing tests do (reuse their setup helper), then:
    expect(screen.queryByText(/total budget/i)).not.toBeInTheDocument();
  });
```

(Adapt to the file's existing render/setup helper — match how the other `SettingsPanel` tests mount the component.)

- [ ] **Step 2: Run the tests — verify they FAIL**

Run: `bun run --cwd cire/organiser test -- Overview.budget`
Expected: FAIL — the card still reads "Coming soon".
Run: `bun run --cwd cire/organiser test -- SettingsPanel`
Expected: FAIL on the new case — the budget field still renders.

- [ ] **Step 3: Widen the `onNavigate` prop type in `Overview.tsx`**

Change the `onNavigate` prop (line ~91) to accept `budget`:

```typescript
  onNavigate: (
    module: "guests" | "schedule" | "checklist" | "budget" | "invite" | "settings",
    sub?: string,
  ) => void;
```

- [ ] **Step 4: Add the budget import + fetch-lift in `Overview.tsx`**

Add to the imports (beside the tasks-store import, line 7):

```typescript
import {
  type BudgetSnapshot,
  ensureBudgetLoaded,
  spentSoFar,
  upcomingPayments,
} from "../lib/budget-store";
```

Add a budget fetch to the `Promise.all([...])` load block (after the `ensureTasksLoaded(...)` entry, ~line 131):

```typescript
        ensureBudgetLoaded(props.weddingId, async () => {
          const res = await authFetch(apiUrl(`/api/organiser/weddings/${props.weddingId}/budget`));
          if (res.status === 401) {
            redirectToLogin();
            return { items: [], payments: [], budgetTotalMinor: null, currency: "AUD" };
          }
          if (!res.ok) throw new Error(`budget ${res.status}`);
          return (await res.json()) as BudgetSnapshot;
        }),
```

- [ ] **Step 5: Replace the Budget "coming soon" card in `Overview.tsx`**

Replace the Budget `SnapshotComingSoon` block (~lines 417–435) with a live snapshot. `spentSoFar(props.weddingId)` is `null` while loading. Money is minor units; format with a small helper (add it near the top of the file if not present):

```tsx
            {/* ── Budget snapshot (Phase 1 — live spend + upcoming payments) ── */}
            <button
              type="button"
              onClick={() => props.onNavigate("budget")}
              class="border-border bg-surface/15 hover:border-gold/40 flex flex-col gap-2 rounded-sm border p-5 text-left transition-colors"
            >
              <p class="font-body text-gold-dim text-[0.7rem] tracking-[0.18em] uppercase">Budget</p>
              <Show
                when={spentSoFar(props.weddingId) !== null}
                fallback={<p class="text-text-muted text-[0.82rem]">Loading your budget…</p>}
              >
                <Show
                  when={data()?.profile?.budgetTotalMinor != null}
                  fallback={
                    <p class="text-text-muted text-[0.82rem]">
                      {(spentSoFar(props.weddingId) ?? 0) > 0
                        ? `${fmtBudget(spentSoFar(props.weddingId)!, budgetCurrency())} tracked — set a total →`
                        : "No budget yet — add your first item."}
                    </p>
                  }
                >
                  <p class="text-text text-[0.95rem]">
                    <span class="text-gold text-[1.2rem] font-semibold">
                      {fmtBudget(spentSoFar(props.weddingId) ?? 0, budgetCurrency())}
                    </span>{" "}
                    <span class="text-text-muted">
                      of {fmtBudget(data()!.profile!.budgetTotalMinor!, budgetCurrency())}
                    </span>
                  </p>
                </Show>
                <Show when={upcomingPayments(props.weddingId).length > 0}>
                  <p class="text-text-muted text-[0.78rem]">
                    Next: {upcomingPayments(props.weddingId)[0]!.label}
                    <Show when={upcomingPayments(props.weddingId)[0]!.dueAt}>
                      {" "}· due {upcomingPayments(props.weddingId)[0]!.dueAt}
                    </Show>
                  </p>
                </Show>
              </Show>
            </button>
```

Add these two helpers near the top of `Overview.tsx` (after the imports), if not already present:

```typescript
function fmtBudget(minor: number, currency: string): string {
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency }).format(minor / 100);
  } catch {
    return (minor / 100).toFixed(2);
  }
}
```

And inside the component, a currency accessor reading the cached budget snapshot (falls back to the profile currency):

```typescript
  const budgetCurrency = () =>
    peekCachedBudget(props.weddingId)?.currency ?? data()?.profile?.currency ?? "AUD";
```

Add `peekCachedBudget` to the budget-store import in Step 4 if you use it here. (If `Show` is not already imported from `solid-js`, it is — Overview already uses it.)

- [ ] **Step 6: Remove the budget field from `SettingsPanel.tsx`**

The cap now lives on the Budget tab. In `cire/organiser/src/components/SettingsPanel.tsx`:
- Delete the `budget` signal (`const [budget, setBudget] = createSignal("")`, line ~62) and its `setBudget(...)` hydration (line ~74).
- Delete the budget parse/validation block in the form-parse function (lines ~112–115) and drop `budgetTotalMinor` from the PUT body (line ~124) — PATCH semantics mean an omitted field is left unchanged, so the cap is untouched by a Settings save.
- Delete the "Total budget" label + input (lines ~264–270).
- Update the panel's `description` copy (line ~171) to drop "and your budget" (the date + guest estimate remain). Keep the `currency` field (the budget is denominated in it; it's read on the Budget tab).

Leave `WeddingProfile.budgetTotalMinor` in the type (the GET still returns it; the Overview reads it) — only the editable form field is removed.

- [ ] **Step 7: Run the tests — verify they PASS**

Run: `bun run --cwd cire/organiser test -- Overview.budget`
Run: `bun run --cwd cire/organiser test -- SettingsPanel`
Expected: PASS.

- [ ] **Step 8: Run the full organiser suite + type-check**

Run: `bun run --cwd cire/organiser test`
Run: `bun run check`
Expected: PASS — no regressions, `Module` union total everywhere.

- [ ] **Step 9: Commit**

```bash
git add cire/organiser/src/components/Overview.tsx cire/organiser/src/components/Overview.budget.test.tsx cire/organiser/src/components/SettingsPanel.tsx cire/organiser/src/components/SettingsPanel.test.tsx
git commit -m "feat(cire/organiser): live budget Overview widget; move cap to Budget tab"
```

---

### Task 9: Changeset + docs

**Files:**
- Create: `.changeset/cire-budget.md`
- Modify: `cire/wiki/todo/platform.md` (tick Budget v1 + Service-category enum)
- Create: `cire/wiki/systems/budget.md` (new-system wiki page)

**Interfaces:** none (docs/metadata only).

- [ ] **Step 1: Write the empty changeset**

Create `.changeset/cire-budget.md` (all `@cire/*` are version-less/ignored → an **empty** changeset with NO package lines):

```markdown
---
---

Phase 1 Budget v1 module: a per-category wedding budget. Organisers add line items
under a service category, track estimate → quoted → actual per item, attach payment
schedule rows (deposit/balance with due + paid dates), and edit the overall cap
from the Budget tab. New `budget_items` + `payments` tables (migration 0039,
additive), a `/api/organiser/weddings/:weddingId/budget` CRUD router (member reads /
editor writes / owner cap), a `BudgetView` module in the organiser IA, and a live
spend-vs-cap + upcoming-payments widget on the Overview. The shared
service-category enum lands here (its first consumer); the cap editor moves out of
Settings.
```

- [ ] **Step 2: Verify the changeset passes the validator**

Run: `bash scripts/validate-changesets.sh` (from repo root)
Expected: PASS — no "mixed ignored + versioned" or "unknown package" error.

- [ ] **Step 3: Update the platform TODO shard**

In `cire/wiki/todo/platform.md`: tick the **Budget v1** line and the **Service-category enum** line (both now shipped), matching the existing "SHIPPED (date)" bullet style the Checklist line uses. Note the cap moved out of Settings into the Budget tab. Bump the shard's `last-reviewed` frontmatter to `2026-07-16`.

- [ ] **Step 4: Write the wiki system page**

Create `cire/wiki/systems/budget.md` with the required frontmatter (`title`, `tags`, `related`, `last-reviewed: 2026-07-16`) documenting: the `budget_items` + `payments` table shapes; the service-category single-source (server `lib/service-categories.ts` + organiser mirror); the route surface + three gates (member read / editor writes / owner cap via the settings service); the rollup spend rule (`actual ?? quoted ?? estimate`); the store fetch-lift; the cap-moved-from-Settings decision; and the deferred items (vendor_id linkage, pricing seeding, multi-currency, recurring payments, reminders). Link `[[platform-plan]]` and `[[checklist-tasks]]`.

- [ ] **Step 5: Final full check**

Run: `bun run --cwd cire/api test && bun run --cwd cire/organiser test && bun run check && bun run lint`
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add .changeset/cire-budget.md cire/wiki/todo/platform.md cire/wiki/systems/budget.md
git commit -m "docs(cire): budget module changeset + wiki + TODO"
```

- [ ] **Step 7: Push + open the PR (do NOT merge — needs user authorization for the 0039 prod migration)**

```bash
git push -u origin feat/cire-budget
gh pr create --title "feat(cire): Phase 1 Budget v1 module" --body "…"
```

The PR body should note: migration `0039` is additive (two new empty tables); merging auto-applies it to prod cire-db D1; requesting explicit authorization to merge.

---

## Self-Review

- **Spec coverage:** two tables + shared enum → Task 1/2; three money columns → Tasks 1/2/3/6; payments (due/paid) → Tasks 1/3/6; category-grouped view with subtotals → Task 6; API CRUD + reorder + payments + owner cap + gates + tenancy (item AND payment cross-tenant) → Tasks 3/4; rollup spend rule → Task 3 (+ client mirror Task 5); cap moves into Budget tab + out of Settings → Tasks 4/6/8; Overview spend + upcoming-payments widget → Task 8; budget-store fetch-lift → Task 5; sidebar promotion + module wiring → Task 7; testing (schema/service/route/lockstep/component) → Tasks 1,2,3,4,5,6,7,8; slicing/changeset/wiki → Task 9. All spec sections mapped.
- **Deferred items** (vendor_id, pricing seeding, multi-currency, recurring payments, reminders, cross-category drag) are honored — none implemented; noted in the wiki page (Task 9).
- **Type consistency:** `BudgetItemDto`/`PaymentDto` (API, ms-epoch numbers, minor-unit ints) ↔ `BudgetItemRow`/`PaymentRow` (store, same shape) share field names + JSON shape; `BudgetSnapshot` identical on both sides (items, payments, budgetTotalMinor, currency); `category` string keys identical across server `lib/service-categories.ts` and organiser mirror; `budgetService` method names match their route call-sites; `BudgetItemNotInWedding`/`PaymentNotInItem` tags caught in the routes; `computeRollup` (server) and `itemSpend`/`spentSoFar` (client) share the `actual ?? quoted ?? estimate ?? 0` rule; `move`/`reorderItems` both key on `orderedIds` array-index → `sortOrder`.
- **Edit not create:** Tasks 4, 7, 8 modify existing files (`app.ts`, `dashboard-route.ts`, `ModuleSidebar.tsx`, `ModuleShell.tsx`, `Overview.tsx`, `SettingsPanel.tsx`) — exact insertion/removal points given with line anchors.
- **No placeholders** — every code step carries full code. The only prose-described artifacts are the wiki page (Task 9 §4) and PR body, which are documentation, not code. One flagged verification: Task 4 Step 3 note to confirm `UpdateSettingsBody` accepts a lone `budgetTotalMinor` (all-optional struct) — an interface confirmation, not a placeholder.
```
