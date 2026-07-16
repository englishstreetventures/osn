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

    const ok = await run(
      db,
      budgetService.updateItem({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: id,
        patch: { actualMinor: 1250000 },
      }),
    );
    if (!Exit.isSuccess(ok)) throw new Error("update failed");
    expect(ok.value.actualMinor).toBe(1250000);

    const foreign = await run(
      db,
      budgetService.updateItem({
        weddingId: OTHER,
        itemId: id,
        patch: { name: "hijack" },
      }),
    );
    expect(Exit.isFailure(foreign)).toBe(true);
    if (Exit.isFailure(foreign)) {
      expect(
        foreign.cause._tag === "Fail" && foreign.cause.error instanceof BudgetItemNotInWedding,
      ).toBe(true);
    }
    const row = db
      .select({ name: budgetItems.name })
      .from(budgetItems)
      .where(eq(budgetItems.id, id))
      .get();
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
    await run(
      db,
      budgetService.reorderItems(BOOTSTRAP_WEDDING_ID, "catering" as never, [
        ids[2]!,
        ids[0]!,
        ids[1]!,
      ]),
    );
    const snap = await run(db, budgetService.get(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(snap)) throw new Error("get failed");
    expect(snap.value.items.filter((i) => i.category === "catering").map((i) => i.name)).toEqual([
      "C",
      "A",
      "B",
    ]);
  });

  it("adds a payment, marks it paid then unpaid, and blocks a cross-tenant add", async () => {
    const db = db0();
    const created = await run(db, budgetService.createItem(newItem()));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const itemId = created.value.id;

    const pay = await run(
      db,
      budgetService.addPayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId,
        label: "Deposit",
        amountMinor: 250000,
        dueAt: "2026-03-01",
      }),
    );
    if (!Exit.isSuccess(pay)) throw new Error("add payment failed");
    expect(pay.value.paidAt).toBeNull();

    const paid = await run(
      db,
      budgetService.updatePayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId,
        paymentId: pay.value.id,
        patch: { paid: true },
      }),
    );
    if (!Exit.isSuccess(paid)) throw new Error("mark paid failed");
    expect(typeof paid.value.paidAt).toBe("number");

    const unpaid = await run(
      db,
      budgetService.updatePayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId,
        paymentId: pay.value.id,
        patch: { paid: false },
      }),
    );
    if (!Exit.isSuccess(unpaid)) throw new Error("unmark failed");
    expect(unpaid.value.paidAt).toBeNull();

    // Cross-tenant add: the item is not under OTHER → BudgetItemNotInWedding.
    const foreign = await run(
      db,
      budgetService.addPayment({
        weddingId: OTHER,
        itemId,
        label: "X",
        amountMinor: 1,
        dueAt: null,
      }),
    );
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
    const pay = await run(
      db,
      budgetService.addPayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: a.value.id,
        label: "Deposit",
        amountMinor: 100,
        dueAt: null,
      }),
    );
    if (!Exit.isSuccess(pay)) throw new Error("add failed");
    // Same wedding, but the payment belongs to item A, not item B.
    const wrong = await run(
      db,
      budgetService.updatePayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId: b.value.id,
        paymentId: pay.value.id,
        patch: { paid: true },
      }),
    );
    expect(Exit.isFailure(wrong)).toBe(true);
    if (Exit.isFailure(wrong)) {
      expect(wrong.cause._tag === "Fail" && wrong.cause.error instanceof PaymentNotInItem).toBe(
        true,
      );
    }
  });

  it("removes an item (cascading its payments) and rejects a cross-tenant delete", async () => {
    const db = db0();
    const created = await run(db, budgetService.createItem(newItem()));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const itemId = created.value.id;
    await run(
      db,
      budgetService.addPayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId,
        label: "Deposit",
        amountMinor: 100,
        dueAt: null,
      }),
    );

    const foreign = await run(db, budgetService.removeItem(OTHER, itemId));
    expect(Exit.isFailure(foreign)).toBe(true);

    const own = await run(db, budgetService.removeItem(BOOTSTRAP_WEDDING_ID, itemId));
    expect(Exit.isSuccess(own)).toBe(true);
    expect(db.select().from(budgetItems).where(eq(budgetItems.id, itemId)).all().length).toBe(0);
    expect(db.select().from(payments).where(eq(payments.budgetItemId, itemId)).all().length).toBe(
      0,
    );
  });
});
