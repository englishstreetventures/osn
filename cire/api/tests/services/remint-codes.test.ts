import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, sessions, weddings } from "@cire/db";
import { and, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../../src/db";
import { createDb, seedDb } from "../../src/db/setup";
import type { TestDb } from "../../src/db/setup";
import { remintCodesService } from "../../src/services/remint-codes";

function run<A, E>(db: TestDb, eff: Effect.Effect<A, E, DbService>): Promise<A> {
  return Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));
}

function guestFamilies(db: TestDb, weddingId: string) {
  return db
    .select({
      id: families.id,
      publicId: families.publicId,
      codeSharedAt: families.codeSharedAt,
      firstOpenedAt: families.firstOpenedAt,
    })
    .from(families)
    .where(and(eq(families.weddingId, weddingId), ne(families.kind, "host")))
    .all();
}

describe("remintCodesService.remint", () => {
  it("switches the wedding's code_style and rotates every guest family's code", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const before = guestFamilies(db, BOOTSTRAP_WEDDING_ID);
    expect(before.length).toBeGreaterThan(0);

    const result = await run(db, remintCodesService.remint(BOOTSTRAP_WEDDING_ID, "simple"));
    expect(result.codeStyle).toBe("simple");
    expect(result.reminted).toBe(before.length);

    const [w] = db
      .select({ codeStyle: weddings.codeStyle })
      .from(weddings)
      .where(eq(weddings.id, BOOTSTRAP_WEDDING_ID))
      .all();
    expect(w!.codeStyle).toBe("simple");

    const after = guestFamilies(db, BOOTSTRAP_WEDDING_ID);
    const beforeById = new Map(before.map((f) => [f.id, f.publicId]));
    for (const f of after) {
      // Every code changed.
      expect(f.publicId).not.toBe(beforeById.get(f.id));
      // `simple` codes have a 6-char ungrouped hash → exactly 3 segments.
      expect(f.publicId.split("-")).toHaveLength(3);
    }
  });

  it("clears code_shared_at for rotated families", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const fam = guestFamilies(db, BOOTSTRAP_WEDDING_ID)[0]!;
    db.update(families).set({ codeSharedAt: new Date() }).where(eq(families.id, fam.id)).run();
    expect(
      guestFamilies(db, BOOTSTRAP_WEDDING_ID).find((f) => f.id === fam.id)!.codeSharedAt,
    ).not.toBeNull();

    await run(db, remintCodesService.remint(BOOTSTRAP_WEDDING_ID, "secure"));

    const after = guestFamilies(db, BOOTSTRAP_WEDDING_ID).find((f) => f.id === fam.id)!;
    expect(after.codeSharedAt).toBeNull();
  });

  it("clears first_opened_at for rotated families (the rotated code is unopened)", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const fam = guestFamilies(db, BOOTSTRAP_WEDDING_ID)[0]!;
    db.update(families).set({ firstOpenedAt: new Date() }).where(eq(families.id, fam.id)).run();
    expect(
      guestFamilies(db, BOOTSTRAP_WEDDING_ID).find((f) => f.id === fam.id)!.firstOpenedAt,
    ).not.toBeNull();

    await run(db, remintCodesService.remint(BOOTSTRAP_WEDDING_ID, "secure"));

    const after = guestFamilies(db, BOOTSTRAP_WEDDING_ID).find((f) => f.id === fam.id)!;
    expect(after.firstOpenedAt).toBeNull();
  });

  it("revokes every session of the rotated families", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const fam = guestFamilies(db, BOOTSTRAP_WEDDING_ID)[0]!;
    const now = new Date();
    db.insert(sessions)
      .values({
        id: "s1",
        familyId: fam.id,
        token: "h1",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
      })
      .run();
    expect(db.select().from(sessions).where(eq(sessions.familyId, fam.id)).all()).toHaveLength(1);

    await run(db, remintCodesService.remint(BOOTSTRAP_WEDDING_ID, "secure"));

    expect(db.select().from(sessions).where(eq(sessions.familyId, fam.id)).all()).toHaveLength(0);
  });

  it("fails WeddingNotFound for an unknown wedding", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const exit = await Effect.runPromiseExit(
      remintCodesService.remint("wed_nope", "simple").pipe(Effect.provideService(DbService, db)),
    );
    expect(exit._tag).toBe("Failure");
  });
});

describe("remintCodesService.remint — chunking contract (>24 families)", () => {
  it("chunks under D1's 50-statement cap without ever splitting a family's rotate+revoke pair", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const now = new Date();
    // Top the wedding up to 30 guest families, each with a live session — a
    // write set of 1 + 30×2 = 61 statements, past the 50-statement cap that a
    // single unchunked batch would blow.
    const existing = guestFamilies(db, BOOTSTRAP_WEDDING_ID).length;
    for (let i = existing; i < 30; i++) {
      const fid = `fam_chunk_${i}`;
      db.insert(families)
        .values({
          id: fid,
          weddingId: BOOTSTRAP_WEDDING_ID,
          publicId: `CHUNK-OLD-${i}`,
          familyName: `Chunk ${i}`,
          createdAt: now,
          updatedAt: now,
        })
        .run();
      db.insert(sessions)
        .values({
          id: `ses_chunk_${i}`,
          familyId: fid,
          token: `tok_chunk_${i}`,
          expiresAt: new Date(now.getTime() + 86_400_000),
          createdAt: now,
        })
        .run();
    }
    expect(guestFamilies(db, BOOTSTRAP_WEDDING_ID)).toHaveLength(30);

    // bun:sqlite has no .batch(); graft a recording one on so the service takes
    // the D1 batch path — sizes prove the packing, execution stays real.
    const batchSizes: number[] = [];
    (db as unknown as { batch: (stmts: unknown[]) => Promise<void> }).batch = async (
      stmts: unknown[],
    ) => {
      batchSizes.push(stmts.length);
      for (const s of stmts) await (s as PromiseLike<unknown>);
    };

    const result = await run(db, remintCodesService.remint(BOOTSTRAP_WEDDING_ID, "secure"));
    expect(result.reminted).toBe(30);

    // Packing: [style flip + 24 pairs] = 49, then [6 pairs] = 12. A split pair
    // would surface as an even/odd boundary shift (e.g. a 50-statement batch).
    expect(batchSizes).toEqual([49, 12]);

    // Convergence at scale: every code rotated onto the secure shape and every
    // session revoked.
    const after = guestFamilies(db, BOOTSTRAP_WEDDING_ID);
    expect(after.every((f) => !f.publicId.startsWith("CHUNK-OLD-"))).toBe(true);
    expect(db.select().from(sessions).all()).toHaveLength(0);
  });
});
