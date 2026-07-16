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
      bucket = {
        category: it.category,
        estimateMinor: 0,
        quotedMinor: 0,
        actualMinor: 0,
        itemCount: 0,
      };
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
            and(
              eq(budgetItems.weddingId, input.weddingId),
              eq(budgetItems.category, input.category),
            ),
          )
          .all(),
      );
      const maxSort = (existing as { sortOrder: number }[]).reduce(
        (m, r) => Math.max(m, r.sortOrder),
        -1,
      );
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
        db
          .delete(payments)
          .where(and(eq(payments.id, paymentId), eq(payments.budgetItemId, itemId)))
          .run(),
      );
    }).pipe(Effect.withSpan("cire.budget.removePayment"));
  },
};
