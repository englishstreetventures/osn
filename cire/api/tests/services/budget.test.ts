import { describe, expect, it } from "bun:test";

import {
  BOOTSTRAP_WEDDING_ID,
  budgetItems,
  events,
  families,
  guestEvents,
  guests,
  payments,
  rsvps,
  weddings,
} from "@cire/db";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import {
  BudgetItemNotInWedding,
  budgetService,
  computeRollup,
  countHeads,
  EventNotInWedding,
  type Invitation,
  lineEstimate,
  PaymentNotInItem,
  perHeadMinor,
} from "../../src/services/budget";

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
        Option.getOrUndefined(Cause.findErrorOption(foreign.cause)) instanceof
          BudgetItemNotInWedding,
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
        Option.getOrUndefined(Cause.findErrorOption(foreign.cause)) instanceof
          BudgetItemNotInWedding,
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
      expect(
        Option.getOrUndefined(Cause.findErrorOption(wrong.cause)) instanceof PaymentNotInItem,
      ).toBe(true);
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

describe("budgetService.updatePayment — empty patch", () => {
  it("degrades to a plain read (no drizzle empty-SET throw) and keeps PaymentNotInItem", async () => {
    const db = db0();
    const created = await run(db, budgetService.createItem(newItem()));
    if (!Exit.isSuccess(created)) throw new Error("create item failed");
    const itemId = created.value.id;
    const pay = await run(
      db,
      budgetService.addPayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId,
        label: "Deposit",
        amountMinor: 100,
        dueAt: null,
      }),
    );
    if (!Exit.isSuccess(pay)) throw new Error("add payment failed");

    // PATCH {} → the unchanged payment echoes back through the select branch.
    const res = await run(
      db,
      budgetService.updatePayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId,
        paymentId: pay.value.id,
        patch: {},
      }),
    );
    if (!Exit.isSuccess(res)) throw new Error("empty patch failed");
    // createdAt compared loosely: the DTO from addPayment carries ms, the
    // read-back row is stored at whole-second precision.
    const { createdAt, ...rest } = res.value;
    const { createdAt: createdAtBefore, ...restBefore } = pay.value;
    expect(rest).toEqual(restBefore);
    expect(Math.abs(createdAt - createdAtBefore)).toBeLessThan(1000);

    // Unknown payment + empty patch still maps to PaymentNotInItem, not a defect.
    const missing = await run(
      db,
      budgetService.updatePayment({
        weddingId: BOOTSTRAP_WEDDING_ID,
        itemId,
        paymentId: "pay_nope",
        patch: {},
      }),
    );
    expect(Exit.isFailure(missing)).toBe(true);
    if (Exit.isFailure(missing)) {
      expect(missing.cause.toString()).toContain("PaymentNotInItem");
    }
  });
});

describe("countHeads", () => {
  const inv = (guestId: string, eventId: string, status: Invitation["status"]): Invitation => ({
    guestId,
    eventId,
    status,
  });

  it("expects every invited guest who has not declined, and confirms the attending ones", () => {
    const heads = countHeads(
      [
        inv("g1", "e1", "attending"),
        inv("g2", "e1", "maybe"),
        inv("g3", "e1", null),
        inv("g4", "e1", "declined"),
      ],
      null,
    );
    // An unanswered invitation (null) is expected: `null !== "declined"`.
    expect(heads).toEqual({ expected: 3, confirmed: 1 });
  });

  it("counts a guest invited to two of the line's events once", () => {
    const heads = countHeads(
      [
        inv("g1", "e1", "attending"),
        inv("g1", "e2", "attending"),
        inv("g2", "e1", "declined"),
        inv("g2", "e2", null),
      ],
      null,
    );
    // g2 declined one event but has not answered the other, so is still expected.
    expect(heads).toEqual({ expected: 2, confirmed: 1 });
  });

  it("counts only the picked events, and nobody when the list is empty", () => {
    const invitations = [inv("g1", "e1", "attending"), inv("g2", "e2", "attending")];
    expect(countHeads(invitations, ["e2"])).toEqual({ expected: 1, confirmed: 1 });
    expect(countHeads(invitations, [])).toEqual({ expected: 0, confirmed: 0 });
  });
});

describe("perHeadMinor and lineEstimate", () => {
  const headcount = { expected: 120, confirmed: 80 };

  it("prices expected guests while RSVPs are open and confirmed guests once closed", () => {
    expect(perHeadMinor(8_500, headcount, false)).toBe(8_500 * 120);
    expect(perHeadMinor(8_500, headcount, true)).toBe(8_500 * 80);
  });

  it("keeps a fixed line's stored estimate", () => {
    const fixed = { estimateMinor: 4_200, unitPriceMinor: null, headcount: null };
    expect(lineEstimate(fixed, false)).toBe(4_200);
    const perHead = { estimateMinor: null, unitPriceMinor: 100, headcount };
    expect(lineEstimate(perHead, false)).toBe(12_000);
    expect(lineEstimate(perHead, true)).toBe(8_000);
  });
});

describe("budgetService — per-head lines", () => {
  const W = "wed_per_head";
  const CEREMONY = "evt_ph_ceremony";
  const RECEPTION = "evt_ph_reception";

  /**
   * A wedding with two events and a guest list that exercises every counting rule:
   *   a1  ceremony attending, reception declined  → expected, confirmed
   *   a2  declined both                           → neither
   *   b1  reception only, no reply                → expected
   *       (and an "attending" RSVP on the ceremony it is NOT invited to — ignored)
   *   b2  ceremony maybe                          → expected
   *   h1  host preview household, attending both  → left out
   *   d1  withdrawn household, ceremony attending → left out
   * All events: expected {a1, b1, b2} = 3, confirmed {a1} = 1.
   */
  function perHeadDb() {
    const db = db0();
    const now = new Date();
    db.insert(weddings)
      .values({
        id: W,
        slug: "per-head",
        displayName: "Per head",
        ownerOsnProfileId: "usr_ph",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    for (const [id, name, sortOrder] of [
      [RECEPTION, "Reception", 1],
      [CEREMONY, "Ceremony", 0],
    ] as const) {
      db.insert(events)
        .values({
          id,
          weddingId: W,
          slug: id,
          name,
          startAt: "2027-03-01T15:00:00+11:00",
          endAt: "",
          timezone: "Australia/Sydney",
          sortOrder,
        })
        .run();
    }
    const family = (id: string, kind: "guest" | "host", deactivated: boolean) =>
      db
        .insert(families)
        .values({
          id,
          weddingId: W,
          publicId: `PH-${id}`,
          familyName: id,
          kind,
          deactivatedAt: deactivated ? now : null,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    family("fam_a", "guest", false);
    family("fam_b", "guest", false);
    family("fam_h", "host", false);
    family("fam_d", "guest", true);
    const guest = (id: string, familyId: string) =>
      db
        .insert(guests)
        .values({ id, familyId, firstName: id, createdAt: now, updatedAt: now })
        .run();
    const invite = (guestId: string, eventId: string) =>
      db.insert(guestEvents).values({ guestId, eventId }).run();
    const reply = (guestId: string, eventId: string, status: "attending" | "declined" | "maybe") =>
      db
        .insert(rsvps)
        .values({ id: `rsvp_${guestId}_${eventId}`, guestId, eventId, status, createdAt: now })
        .run();
    guest("a1", "fam_a");
    guest("a2", "fam_a");
    guest("b1", "fam_b");
    guest("b2", "fam_b");
    guest("h1", "fam_h");
    guest("d1", "fam_d");
    for (const g of ["a1", "a2"]) {
      invite(g, CEREMONY);
      invite(g, RECEPTION);
    }
    reply("a1", CEREMONY, "attending");
    reply("a1", RECEPTION, "declined");
    reply("a2", CEREMONY, "declined");
    reply("a2", RECEPTION, "declined");
    invite("b1", RECEPTION);
    reply("b1", CEREMONY, "attending");
    invite("b2", CEREMONY);
    reply("b2", CEREMONY, "maybe");
    invite("h1", CEREMONY);
    invite("h1", RECEPTION);
    reply("h1", CEREMONY, "attending");
    reply("h1", RECEPTION, "attending");
    invite("d1", CEREMONY);
    reply("d1", CEREMONY, "attending");
    return db;
  }

  const perHeadItem = (
    perHead: { unitPriceMinor: number; eventIds?: readonly string[] | null } | null,
    over: Partial<{ estimateMinor: number | null; weddingId: string }> = {},
  ) => ({
    weddingId: over.weddingId ?? W,
    category: "catering" as never,
    name: "Dinner",
    estimateMinor: over.estimateMinor ?? null,
    quotedMinor: null,
    actualMinor: null,
    notes: null,
    perHead,
  });

  const errorOf = (exit: Exit.Exit<unknown, unknown>) =>
    Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;

  it("counts guests across every event and prices the expected ones while RSVPs are open", async () => {
    const db = perHeadDb();
    const created = await run(db, budgetService.createItem(perHeadItem({ unitPriceMinor: 5_000 })));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    expect(created.value.unitPriceMinor).toBe(5_000);
    expect(created.value.eventIds).toBeNull();
    expect(created.value.headcount).toEqual({ expected: 3, confirmed: 1 });

    const snap = await run(db, budgetService.get(W));
    if (!Exit.isSuccess(snap)) throw new Error("get failed");
    expect(snap.value.rsvpsClosed).toBe(false);
    // The portal's order: sort_order, not insertion order.
    expect(snap.value.events).toEqual([
      { id: CEREMONY, name: "Ceremony" },
      { id: RECEPTION, name: "Reception" },
    ]);
    expect(snap.value.items[0]?.headcount).toEqual({ expected: 3, confirmed: 1 });
    expect(snap.value.rollup.totals.estimateMinor).toBe(15_000);
    expect(snap.value.rollup.spentSoFarMinor).toBe(15_000);
  });

  it("prices confirmed guests once the RSVP deadline has passed", async () => {
    const db = perHeadDb();
    db.update(weddings)
      .set({ rsvpDeadline: "2020-01-01", rsvpDeadlineTimezone: "UTC" })
      .where(eq(weddings.id, W))
      .run();
    await run(db, budgetService.createItem(perHeadItem({ unitPriceMinor: 5_000 })));
    const snap = await run(db, budgetService.get(W));
    if (!Exit.isSuccess(snap)) throw new Error("get failed");
    expect(snap.value.rsvpsClosed).toBe(true);
    expect(snap.value.rollup.totals.estimateMinor).toBe(5_000);
  });

  it("lets a quote or an actual win over the per-head amount in the spend total", async () => {
    const db = perHeadDb();
    const created = await run(db, budgetService.createItem(perHeadItem({ unitPriceMinor: 5_000 })));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: created.value.id,
        patch: { quotedMinor: 9_999 },
      }),
    );
    const snap = await run(db, budgetService.get(W));
    if (!Exit.isSuccess(snap)) throw new Error("get failed");
    expect(snap.value.rollup.spentSoFarMinor).toBe(9_999);
    expect(snap.value.rollup.totals.estimateMinor).toBe(15_000);
  });

  it("counts only the picked events", async () => {
    const db = perHeadDb();
    const reception = await run(
      db,
      budgetService.createItem(perHeadItem({ unitPriceMinor: 100, eventIds: [RECEPTION] })),
    );
    if (!Exit.isSuccess(reception)) throw new Error("create failed");
    expect(reception.value.eventIds).toEqual([RECEPTION]);
    // a1 and a2 declined the reception; b1 has not replied.
    expect(reception.value.headcount).toEqual({ expected: 1, confirmed: 0 });

    const ceremony = await run(
      db,
      budgetService.createItem(
        perHeadItem({ unitPriceMinor: 100, eventIds: [CEREMONY, CEREMONY] }),
      ),
    );
    if (!Exit.isSuccess(ceremony)) throw new Error("create failed");
    // Duplicates collapse; b1's RSVP to an event it is not invited to is ignored.
    expect(ceremony.value.eventIds).toEqual([CEREMONY]);
    expect(ceremony.value.headcount).toEqual({ expected: 2, confirmed: 1 });
  });

  it("refuses an event from another wedding and writes nothing", async () => {
    const db = perHeadDb();
    const [bootstrapEvent] = db
      .select({ id: events.id })
      .from(events)
      .where(eq(events.weddingId, BOOTSTRAP_WEDDING_ID))
      .all();
    const created = await run(
      db,
      budgetService.createItem(
        perHeadItem({ unitPriceMinor: 100, eventIds: [CEREMONY, bootstrapEvent!.id] }),
      ),
    );
    expect(errorOf(created) instanceof EventNotInWedding).toBe(true);
    expect(db.select().from(budgetItems).where(eq(budgetItems.weddingId, W)).all()).toEqual([]);

    const fixed = await run(db, budgetService.createItem(perHeadItem(null)));
    if (!Exit.isSuccess(fixed)) throw new Error("create failed");
    const patched = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: fixed.value.id,
        patch: { perHead: { unitPriceMinor: 1, eventIds: ["evt_nope"] } },
      }),
    );
    expect(errorOf(patched) instanceof EventNotInWedding).toBe(true);
    const row = db.select().from(budgetItems).where(eq(budgetItems.id, fixed.value.id)).get();
    expect(row?.unitPriceMinor).toBeNull();
  });

  it("clears a fixed estimate when a line goes per head, and the event list when it goes back", async () => {
    const db = perHeadDb();
    const fixed = await run(
      db,
      budgetService.createItem(perHeadItem(null, { estimateMinor: 7_000 })),
    );
    if (!Exit.isSuccess(fixed)) throw new Error("create failed");
    expect(fixed.value.headcount).toBeNull();
    const id = fixed.value.id;

    const perHead = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: id,
        patch: { perHead: { unitPriceMinor: 2_000, eventIds: [CEREMONY] } },
      }),
    );
    if (!Exit.isSuccess(perHead)) throw new Error("to per head failed");
    expect(perHead.value.estimateMinor).toBeNull();
    expect(perHead.value.eventIds).toEqual([CEREMONY]);

    const back = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: id,
        patch: { perHead: null, estimateMinor: 4_000 },
      }),
    );
    if (!Exit.isSuccess(back)) throw new Error("to fixed failed");
    expect(back.value).toMatchObject({
      unitPriceMinor: null,
      eventIds: null,
      headcount: null,
      estimateMinor: 4_000,
    });
    const row = db.select().from(budgetItems).where(eq(budgetItems.id, id)).get();
    expect(row?.perHeadEventIds).toBeNull();
  });

  it("drops an estimate sent for a line that is already per head", async () => {
    const db = perHeadDb();
    const created = await run(db, budgetService.createItem(perHeadItem({ unitPriceMinor: 100 })));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const res = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: created.value.id,
        patch: { estimateMinor: 500 },
      }),
    );
    if (!Exit.isSuccess(res)) throw new Error("update failed");
    expect(res.value.estimateMinor).toBeNull();

    // The same patch on a fixed line still sets it.
    const fixed = await run(db, budgetService.createItem(perHeadItem(null)));
    if (!Exit.isSuccess(fixed)) throw new Error("create failed");
    const ok = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: fixed.value.id,
        patch: { estimateMinor: 500 },
      }),
    );
    if (!Exit.isSuccess(ok)) throw new Error("update failed");
    expect(ok.value.estimateMinor).toBe(500);
  });

  it("keeps the picked events on a price-only edit, and null counts every event", async () => {
    const db = perHeadDb();
    const created = await run(
      db,
      budgetService.createItem(perHeadItem({ unitPriceMinor: 100, eventIds: [RECEPTION] })),
    );
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const id = created.value.id;
    const priceOnly = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: id,
        patch: { perHead: { unitPriceMinor: 300 } },
      }),
    );
    if (!Exit.isSuccess(priceOnly)) throw new Error("update failed");
    expect(priceOnly.value.unitPriceMinor).toBe(300);
    expect(priceOnly.value.eventIds).toEqual([RECEPTION]);

    const every = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: id,
        patch: { perHead: { unitPriceMinor: 300, eventIds: null } },
      }),
    );
    if (!Exit.isSuccess(every)) throw new Error("update failed");
    expect(every.value.eventIds).toBeNull();
    expect(every.value.headcount).toEqual({ expected: 3, confirmed: 1 });
  });

  it("counts nobody once every picked event is deleted, and a price-only edit does not widen it", async () => {
    const db = perHeadDb();
    const created = await run(
      db,
      budgetService.createItem(perHeadItem({ unitPriceMinor: 100, eventIds: [RECEPTION] })),
    );
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    db.delete(events).where(eq(events.id, RECEPTION)).run();

    const snap = await run(db, budgetService.get(W));
    if (!Exit.isSuccess(snap)) throw new Error("get failed");
    expect(snap.value.items[0]?.eventIds).toEqual([]);
    expect(snap.value.items[0]?.headcount).toEqual({ expected: 0, confirmed: 0 });

    const priceOnly = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: created.value.id,
        patch: { perHead: { unitPriceMinor: 200 } },
      }),
    );
    if (!Exit.isSuccess(priceOnly)) throw new Error("update failed");
    expect(priceOnly.value.eventIds).toEqual([]);
    expect(priceOnly.value.headcount).toEqual({ expected: 0, confirmed: 0 });
  });

  it("counts nobody from a stored event list it cannot read, never everybody", async () => {
    const db = perHeadDb();
    const created = await run(db, budgetService.createItem(perHeadItem({ unitPriceMinor: 100 })));
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    const stored = async (text: string) => {
      db.update(budgetItems)
        .set({ perHeadEventIds: text })
        .where(eq(budgetItems.id, created.value.id))
        .run();
      const snap = await run(db, budgetService.get(W));
      if (!Exit.isSuccess(snap)) throw new Error("get failed");
      return snap.value.items[0]!;
    };
    for (const text of ["not json", '{"a":1}']) {
      const line = await stored(text);
      expect(line.eventIds).toEqual([]);
      expect(line.headcount).toEqual({ expected: 0, confirmed: 0 });
    }
    const mixed = await stored(`[1, "${CEREMONY}"]`);
    expect(mixed.eventIds).toEqual([CEREMONY]);
    expect(mixed.headcount).toEqual({ expected: 2, confirmed: 1 });
  });

  it("stores no estimate on a per-head line even when a caller passes one", async () => {
    const db = perHeadDb();
    const created = await run(
      db,
      budgetService.createItem(perHeadItem({ unitPriceMinor: 100 }, { estimateMinor: 7_000 })),
    );
    if (!Exit.isSuccess(created)) throw new Error("create failed");
    expect(created.value.estimateMinor).toBeNull();
    const row = db.select().from(budgetItems).where(eq(budgetItems.id, created.value.id)).get();
    expect(row?.estimateMinor).toBeNull();

    // Back to fixed with no estimate: nothing hidden comes back.
    const back = await run(
      db,
      budgetService.updateItem({
        weddingId: W,
        itemId: created.value.id,
        patch: { perHead: null },
      }),
    );
    if (!Exit.isSuccess(back)) throw new Error("update failed");
    expect(back.value.estimateMinor).toBeNull();
  });

  it("reads a fixed line with no per-head fields and its stored estimate", async () => {
    const db = perHeadDb();
    await run(db, budgetService.createItem(perHeadItem(null, { estimateMinor: 1_000 })));
    const snap = await run(db, budgetService.get(W));
    if (!Exit.isSuccess(snap)) throw new Error("get failed");
    expect(snap.value.items[0]).toMatchObject({
      unitPriceMinor: null,
      eventIds: null,
      headcount: null,
    });
    expect(snap.value.rollup.totals.estimateMinor).toBe(1_000);
  });
});
