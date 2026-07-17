import { describe, expect, it } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, vendors, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect, Exit } from "effect";

import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { vendorsService, VendorNotInWedding } from "./vendors";

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
        res.cause._tag === "Fail" &&
        res.cause.error instanceof VendorNotInWedding,
    ).toBe(true);
    // unchanged
    const row = db.select().from(vendors).where(eq(vendors.id, mine.value.id)).get();
    expect(row?.status).toBe("researching");
  });

  it("existsForDirectory is true only when a CRM row links that listing in that wedding", async () => {
    const db = db0();
    // Create a vendor in W1 (BOOTSTRAP_WEDDING_ID) with directoryVendorId "DV1"
    const created = await run(
      db,
      vendorsService.create({
        weddingId: BOOTSTRAP_WEDDING_ID,
        name: "Apex Venue",
        category: "venue",
        status: "researching",
        contactName: null,
        email: null,
        phone: null,
        notes: null,
        quotedMinor: null,
        directoryVendorId: "DV1",
      }),
    );
    expect(Exit.isSuccess(created)).toBe(true);

    // True: same wedding, same directoryVendorId
    const r1 = await run(db, vendorsService.existsForDirectory(BOOTSTRAP_WEDDING_ID, "DV1"));
    expect(Exit.isSuccess(r1) && r1.value).toBe(true);

    // False: same wedding, different directoryVendorId
    const r2 = await run(db, vendorsService.existsForDirectory(BOOTSTRAP_WEDDING_ID, "DVX"));
    expect(Exit.isSuccess(r2) && r2.value).toBe(false);

    // False: different wedding, same directoryVendorId (wedding-scoping)
    const r3 = await run(db, vendorsService.existsForDirectory(OTHER, "DV1"));
    expect(Exit.isSuccess(r3) && r3.value).toBe(false);
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
