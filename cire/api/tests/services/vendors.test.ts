import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, vendors, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Cause, Effect, Exit, Option } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import { vendorsService, VendorNotInWedding } from "../../src/services/vendors";
import { recordStatements } from "../test-helpers";

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
const run = <A, E>(db: ReturnType<typeof createDb>, e: Effect.Effect<A, E, DbService>) =>
  Effect.runPromiseExit(e.pipe(Effect.provideService(DbService, db)));

describe("vendorsService", () => {
  it("creates a vendor appended to its status group and lists it", async () => {
    const db = db0();
    const a = await run(
      db,
      vendorsService.create({
        weddingId: BOOTSTRAP_WEDDING_ID,
        name: "Bloom",
        category: "florals",
        status: "researching",
        contactName: null,
        email: null,
        phone: null,
        notes: null,
        quotedMinor: null,
      }),
    );
    expect(Exit.isSuccess(a)).toBe(true);
    const list = await run(db, vendorsService.list(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(list)) throw new Error("list failed");
    expect(list.value.map((v) => v.name)).toEqual(["Bloom"]);
    expect(list.value[0]!.status).toBe("researching");
  });

  it("rejects updating another wedding's vendor (tenancy)", async () => {
    const db = db0();
    const mine = await run(
      db,
      vendorsService.create({
        weddingId: BOOTSTRAP_WEDDING_ID,
        name: "Bloom",
        category: "florals",
        status: "researching",
        contactName: null,
        email: null,
        phone: null,
        notes: null,
        quotedMinor: null,
      }),
    );
    if (!Exit.isSuccess(mine)) throw new Error("create failed");
    const res = await run(db, vendorsService.update(OTHER, mine.value.id, { status: "booked" }));
    expect(
      Exit.isFailure(res) &&
        Option.getOrUndefined(Cause.findErrorOption(res.cause)) instanceof VendorNotInWedding,
    ).toBe(true);
    // unchanged
    const row = db.select().from(vendors).where(eq(vendors.id, mine.value.id)).get();
    expect(row?.status).toBe("researching");
  });

  it("reorder is wedding-scoped and sets sort_order by index within a status", async () => {
    const db = db0();
    const ids: string[] = [];
    for (const name of ["A", "B", "C"]) {
      const r = await run(
        db,
        vendorsService.create({
          weddingId: BOOTSTRAP_WEDDING_ID,
          name,
          category: "venue",
          status: "contacted",
          contactName: null,
          email: null,
          phone: null,
          notes: null,
          quotedMinor: null,
        }),
      );
      if (!Exit.isSuccess(r)) throw new Error("create failed");
      ids.push(r.value.id);
    }
    await run(
      db,
      vendorsService.reorder(BOOTSTRAP_WEDDING_ID, "contacted", [ids[2]!, ids[0]!, ids[1]!]),
    );
    // foreign wedding reorder is a no-op
    await run(db, vendorsService.reorder(OTHER, "contacted", [ids[0]!, ids[1]!, ids[2]!]));
    const list = await run(db, vendorsService.list(BOOTSTRAP_WEDDING_ID));
    if (!Exit.isSuccess(list)) throw new Error("list failed");
    expect(list.value.filter((v) => v.status === "contacted").map((v) => v.name)).toEqual([
      "C",
      "A",
      "B",
    ]);
  });
});

describe("vendorsService.create sort order", () => {
  function seedVendor(
    db: ReturnType<typeof createDb>,
    weddingId: string,
    status: string,
    sortOrder: number,
  ) {
    const now = new Date();
    db.insert(vendors)
      .values({
        id: `ven_${crypto.randomUUID()}`,
        weddingId,
        name: `Seeded ${status} ${sortOrder}`,
        category: "venue",
        status,
        sortOrder,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const input = {
    weddingId: BOOTSTRAP_WEDDING_ID,
    name: "New",
    category: "florals",
    status: "contacted",
    contactName: null,
    email: null,
    phone: null,
    notes: null,
    quotedMinor: null,
  };

  it("appends after the highest sort_order in its (wedding, status) group", async () => {
    const db = db0();
    // Gaps and out-of-order inserts, as a reorder then a delete leave them.
    for (const n of [0, 7, 3]) seedVendor(db, BOOTSTRAP_WEDDING_ID, "contacted", n);
    // Higher values outside the group must not count.
    seedVendor(db, BOOTSTRAP_WEDDING_ID, "booked", 40);
    seedVendor(db, OTHER, "contacted", 50);

    const res = await run(db, vendorsService.create(input));
    if (!Exit.isSuccess(res)) throw new Error("create failed");
    expect(res.value.sortOrder).toBe(8);
  });

  it("starts an empty group at 0", async () => {
    const db = db0();
    seedVendor(db, BOOTSTRAP_WEDDING_ID, "booked", 5);
    const res = await run(db, vendorsService.create(input));
    if (!Exit.isSuccess(res)) throw new Error("create failed");
    expect(res.value.sortOrder).toBe(0);
  });

  it("reads one row for the top sort_order however large the group", async () => {
    const db = db0();
    for (const n of [0, 1, 2]) seedVendor(db, BOOTSTRAP_WEDDING_ID, "contacted", n);
    const statements = recordStatements(db);

    await run(db, vendorsService.create(input));

    const reads = statements.filter((s) => /^select\b/i.test(s.sql));
    expect(reads).toHaveLength(1);
    expect(reads[0]!.rowCounts).toEqual([1]);
  });

  it("finds the top sort_order through the (wedding, status, sort_order) index", async () => {
    const db = db0();
    const statements = recordStatements(db);
    await run(db, vendorsService.create(input));
    const read = statements.find((s) => /^select\b/i.test(s.sql));

    const plan = db.$client
      .query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${read!.sql}`)
      .all()
      .map((r) => r.detail)
      .join("\n");
    expect(plan).toMatch(/vendors USING (COVERING )?INDEX vendors_wedding_status_idx/);
    // An ORDER BY the index cannot serve would sort the whole group first.
    expect(plan).not.toMatch(/USE TEMP B-TREE/);
  });
});
