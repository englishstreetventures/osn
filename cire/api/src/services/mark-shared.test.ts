import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families } from "@cire/db";
import { and, eq, ne } from "drizzle-orm";
import { Effect } from "effect";

import { DbService } from "../db";
import type { Db } from "../db";
import { createDb, seedDb } from "../db/setup";
import { markSharedService } from "./mark-shared";

function aFamily(db: Db) {
  return db
    .select({ id: families.id, codeSharedAt: families.codeSharedAt })
    .from(families)
    .where(and(eq(families.weddingId, BOOTSTRAP_WEDDING_ID), ne(families.kind, "host")))
    .all()[0]!;
}

describe("markSharedService.markShared", () => {
  it("sets code_shared_at for a family in the wedding", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const fam = aFamily(db);
    expect(fam.codeSharedAt).toBeNull();

    const result = await Effect.runPromise(
      markSharedService
        .markShared(BOOTSTRAP_WEDDING_ID, fam.id)
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(result.familyId).toBe(fam.id);
    expect(result.codeSharedAt).toBeGreaterThan(0);

    const after = db
      .select({ codeSharedAt: families.codeSharedAt })
      .from(families)
      .where(eq(families.id, fam.id))
      .all()[0]!;
    expect(after.codeSharedAt).not.toBeNull();
  });

  it("fails FamilyNotInWedding for a family under another wedding", async () => {
    const db = createDb(":memory:");
    seedDb(db);
    const exit = await Effect.runPromiseExit(
      markSharedService
        .markShared("wed_nope", aFamily(db).id)
        .pipe(Effect.provideService(DbService, db)),
    );
    expect(exit._tag).toBe("Failure");
  });
});
