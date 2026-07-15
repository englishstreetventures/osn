import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families } from "@cire/db";
import { and, eq, isNull } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../db";
import { DbService } from "../db";
import { createDb, seedBootstrapWedding } from "../db/setup";
import { householdsService } from "./households";

/** A bare DB with just the bootstrap wedding (no seeded families). */
function freshDb(): Db {
  const db = createDb(":memory:");
  seedBootstrapWedding(db);
  return db;
}

const run = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>) =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

describe("householdsService.create", () => {
  it("creates a household with NO claim code (publicId null)", async () => {
    const db = freshDb();
    const created = await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "Nguyen"));
    expect(created.publicId).toBeNull();
    expect(created.familyName).toBe("Nguyen");

    const row = db.select().from(families).where(eq(families.id, created.familyId)).all()[0];
    expect(row).toBeDefined();
    expect(row!.publicId).toBeNull();
    expect(row!.kind).toBe("guest");
    expect(row!.weddingId).toBe(BOOTSTRAP_WEDDING_ID);
  });

  it("trims the household name", async () => {
    const db = freshDb();
    const created = await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "  Smith  "));
    expect(created.familyName).toBe("Smith");
  });

  it("allows MANY code-less households (partial unique index exempts NULL)", async () => {
    const db = freshDb();
    await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "A"));
    await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "B"));
    await run(db, householdsService.create(BOOTSTRAP_WEDDING_ID, "C"));

    const codeless = db
      .select({ id: families.id })
      .from(families)
      .where(and(eq(families.weddingId, BOOTSTRAP_WEDDING_ID), isNull(families.publicId)))
      .all();
    expect(codeless).toHaveLength(3);
  });

  it("fails WeddingNotFound for an unknown wedding", async () => {
    const db = freshDb();
    const err = await run(db, Effect.flip(householdsService.create("wed_nope", "X")));
    expect(err._tag).toBe("WeddingNotFound");
  });
});
