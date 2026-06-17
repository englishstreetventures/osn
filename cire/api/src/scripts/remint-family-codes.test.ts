import { describe, it, expect } from "bun:test";

import { families, sessions, weddings } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import { createDb } from "../db/setup";
import { isLegacyCode, remintFamilyCodes } from "./remint-family-codes";

const WED_A = "wed_a";
const WED_B = "wed_b";

function seedWedding(db: ReturnType<typeof createDb>, id: string, codeStyle: "simple" | "secure") {
  const now = new Date();
  db.insert(weddings)
    .values({
      id,
      slug: `slug-${id}`,
      displayName: id,
      ownerOsnProfileId: "usr_owner",
      codeStyle,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function seedFamily(
  db: ReturnType<typeof createDb>,
  id: string,
  weddingId: string,
  publicId: string,
  familyName: string,
) {
  const now = new Date();
  db.insert(families)
    .values({ id, weddingId, publicId, familyName, createdAt: now, updatedAt: now })
    .run();
}

function run<A, E>(db: ReturnType<typeof createDb>, eff: Effect.Effect<A, E, DbService>) {
  return Effect.runPromise(Effect.provideService(eff, DbService, db) as Effect.Effect<A, E, never>);
}

describe("isLegacyCode", () => {
  it("flags single-hyphen NAME-HEX codes as legacy", () => {
    expect(isLegacyCode("SHARMA-A1B2C3D4")).toBe(true);
    expect(isLegacyCode("FAMILY-0000")).toBe(true);
  });
  it("treats new SURNAME-WORD-HASH codes as non-legacy", () => {
    expect(isLegacyCode("SHARMA-WIDGET-AB3K9X")).toBe(false);
    expect(isLegacyCode("SHARMA-WIDGET-AB3K9-X7QPM")).toBe(false);
  });
});

describe("remintFamilyCodes", () => {
  it("re-mints only legacy codes, tenant-scoped, onto the wedding's tier", async () => {
    const db = createDb(":memory:");
    seedWedding(db, WED_A, "secure");
    seedWedding(db, WED_B, "simple");
    // Wedding A: one legacy, one already-new.
    seedFamily(db, "fa1", WED_A, "SHARMA-A1B2C3D4", "Sharma");
    seedFamily(db, "fa2", WED_A, "PATEL-WIDGET-AB3K9-X7QPM", "Patel");
    // Wedding B: one legacy — must NOT be touched when re-minting A.
    seedFamily(db, "fb1", WED_B, "OTHER-DEADBEEF", "Other");

    const result = await run(db, remintFamilyCodes(WED_A));
    expect(result.reminted).toBe(1);
    expect(result.skipped).toBe(1);

    const fa1 = db.select().from(families).where(eq(families.id, "fa1")).all()[0]!;
    const fa2 = db.select().from(families).where(eq(families.id, "fa2")).all()[0]!;
    const fb1 = db.select().from(families).where(eq(families.id, "fb1")).all()[0]!;

    // fa1 rotated to the new (secure → 4-segment) format.
    expect(fa1.publicId).not.toBe("SHARMA-A1B2C3D4");
    expect(isLegacyCode(fa1.publicId)).toBe(false);
    expect(fa1.publicId.split("-")).toHaveLength(4);
    // fa2 (already new) untouched.
    expect(fa2.publicId).toBe("PATEL-WIDGET-AB3K9-X7QPM");
    // Wedding B untouched (tenant scope).
    expect(fb1.publicId).toBe("OTHER-DEADBEEF");
  });

  it("is idempotent — a second run is a no-op", async () => {
    const db = createDb(":memory:");
    seedWedding(db, WED_A, "secure");
    seedFamily(db, "fa1", WED_A, "SHARMA-A1B2C3D4", "Sharma");

    const first = await run(db, remintFamilyCodes(WED_A));
    expect(first.reminted).toBe(1);
    const code = db.select().from(families).where(eq(families.id, "fa1")).all()[0]!.publicId;

    const second = await run(db, remintFamilyCodes(WED_A));
    expect(second.reminted).toBe(0);
    expect(second.skipped).toBe(1);
    // Code unchanged on the second run.
    expect(db.select().from(families).where(eq(families.id, "fa1")).all()[0]!.publicId).toBe(code);
  });

  it("uses the simple tier (3-segment code) for a simple wedding", async () => {
    const db = createDb(":memory:");
    seedWedding(db, WED_B, "simple");
    seedFamily(db, "fb1", WED_B, "OTHER-DEADBEEF", "Other");
    await run(db, remintFamilyCodes(WED_B));
    const code = db.select().from(families).where(eq(families.id, "fb1")).all()[0]!.publicId;
    expect(code.split("-")).toHaveLength(3);
  });

  it("does not disturb sessions (re-mint rotates codes only; regenerate-code revokes)", async () => {
    const db = createDb(":memory:");
    seedWedding(db, WED_A, "secure");
    seedFamily(db, "fa1", WED_A, "SHARMA-A1B2C3D4", "Sharma");
    const now = new Date();
    db.insert(sessions)
      .values({
        id: "s1",
        familyId: "fa1",
        token: "h1",
        expiresAt: new Date(now.getTime() + 60_000),
        createdAt: now,
      })
      .run();
    await run(db, remintFamilyCodes(WED_A));
    // The bulk re-mint deliberately leaves sessions alone — it's a code refresh,
    // not a per-family revoke. (revoke-on-rotate is the regenerate-code path.)
    expect(db.select().from(sessions).where(eq(sessions.familyId, "fa1")).all()).toHaveLength(1);
  });

  it("fails with wedding_not_found for an unknown wedding", async () => {
    const db = createDb(":memory:");
    const exit = await Effect.runPromiseExit(
      Effect.provideService(remintFamilyCodes("wed_ghost"), DbService, db),
    );
    expect(exit._tag).toBe("Failure");
  });
});
