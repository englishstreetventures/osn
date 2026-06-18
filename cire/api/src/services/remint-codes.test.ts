import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, sessions, weddings } from "@cire/db";
import { and, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { remintCodesService } from "./remint-codes";

function run<A, E>(db: Db, eff: Effect.Effect<A, E, DbService>): Promise<A> {
  return Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));
}

function guestFamilies(db: Db, weddingId: string) {
  return db
    .select({ id: families.id, publicId: families.publicId, codeSharedAt: families.codeSharedAt })
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
