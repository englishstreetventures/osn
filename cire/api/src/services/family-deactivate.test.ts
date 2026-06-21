import { describe, it, expect } from "bun:test";

import { BOOTSTRAP_WEDDING_ID, families, sessions } from "@cire/db";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

import type { Db } from "../db";
import { DbService } from "../db";
import { createDb, seedDb } from "../db/setup";
import { TestDbLayer } from "../db/test-layer";
import { effWith } from "../test-helpers";
import { claimService, InvalidCredentials } from "./claim";
import { familyDeactivateService } from "./family-deactivate";

const withDb = effWith(TestDbLayer);

/** A real guest family id + code in the seeded bootstrap wedding. */
function aFamily(db: Db): { id: string; publicId: string } {
  const row = db
    .select({ id: families.id, publicId: families.publicId })
    .from(families)
    .where(eq(families.weddingId, BOOTSTRAP_WEDDING_ID))
    .all()[0];
  if (!row) throw new Error("no bootstrap family seeded");
  return row;
}

describe("familyDeactivateService.setDeactivated", () => {
  it(
    "sets deactivated_at when deactivating and clears it when reactivating",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const fam = aFamily(db);

        const off = yield* familyDeactivateService.setDeactivated(
          BOOTSTRAP_WEDDING_ID,
          fam.id,
          true,
        );
        expect(off.familyId).toBe(fam.id);
        expect(off.deactivatedAt).toBeGreaterThan(0);
        const [afterOff] = db
          .select({ deactivatedAt: families.deactivatedAt })
          .from(families)
          .where(eq(families.id, fam.id))
          .all();
        expect(afterOff!.deactivatedAt).not.toBeNull();

        const on = yield* familyDeactivateService.setDeactivated(
          BOOTSTRAP_WEDDING_ID,
          fam.id,
          false,
        );
        expect(on.deactivatedAt).toBeNull();
        const [afterOn] = db
          .select({ deactivatedAt: families.deactivatedAt })
          .from(families)
          .where(eq(families.id, fam.id))
          .all();
        expect(afterOn!.deactivatedAt).toBeNull();
      }),
    ),
  );

  it(
    "revokes the family's live sessions when deactivating",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const fam = aFamily(db);
        const now = new Date();
        db.insert(sessions)
          .values({
            id: "s_deact",
            familyId: fam.id,
            token: "h_deact",
            expiresAt: new Date(now.getTime() + 60_000),
            createdAt: now,
          })
          .run();
        expect(db.select().from(sessions).where(eq(sessions.familyId, fam.id)).all()).toHaveLength(
          1,
        );

        yield* familyDeactivateService.setDeactivated(BOOTSTRAP_WEDDING_ID, fam.id, true);
        expect(db.select().from(sessions).where(eq(sessions.familyId, fam.id)).all()).toHaveLength(
          0,
        );
      }),
    ),
  );

  it(
    "fails FamilyNotInWedding when the family is not under the wedding",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const fam = aFamily(db);
        // The family exists, but not under this (different) wedding id — the
        // scope check finds no row and rejects.
        const error = yield* Effect.flip(
          familyDeactivateService.setDeactivated("wed_other_scope", fam.id, true),
        );
        expect(error._tag).toBe("FamilyNotInWedding");
      }),
    ),
  );

  it(
    "refuses to deactivate a host-preview family (kind='host')",
    withDb(
      Effect.gen(function* () {
        const db = yield* DbService;
        const now = new Date();
        db.insert(families)
          .values({
            id: "fam_host",
            weddingId: BOOTSTRAP_WEDDING_ID,
            publicId: "HOST-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            familyName: "Wedding Host",
            kind: "host",
            createdAt: now,
            updatedAt: now,
          })
          .run();
        const error = yield* Effect.flip(
          familyDeactivateService.setDeactivated(BOOTSTRAP_WEDDING_ID, "fam_host", true),
        );
        expect(error._tag).toBe("FamilyNotInWedding");
      }),
    ),
  );
});

describe("claimService.lookup rejects a deactivated family like an unknown code", () => {
  it(
    "fails with InvalidCredentials once deactivated, claims again once reactivated",
    withDb(
      Effect.gen(function* () {
        // An active family claims fine.
        const before = yield* claimService.lookup("TESTONE-IVY-AA11");
        expect(before.publicId).toBe("TESTONE-IVY-AA11");

        const db = yield* DbService;
        const [fam] = db
          .select({ id: families.id })
          .from(families)
          .where(eq(families.publicId, "TESTONE-IVY-AA11"))
          .all();

        yield* familyDeactivateService.setDeactivated(BOOTSTRAP_WEDDING_ID, fam!.id, true);

        // Deactivated → the SAME generic failure an unknown code returns.
        const error = yield* Effect.flip(claimService.lookup("TESTONE-IVY-AA11"));
        expect(error._tag).toBe("InvalidCredentials");
        expect(error).toBeInstanceOf(InvalidCredentials);

        // Reactivating restores the claim (data was never deleted).
        yield* familyDeactivateService.setDeactivated(BOOTSTRAP_WEDDING_ID, fam!.id, false);
        const after = yield* claimService.lookup("TESTONE-IVY-AA11");
        expect(after.publicId).toBe("TESTONE-IVY-AA11");
        expect(after.members.length).toBeGreaterThan(0);
      }),
    ),
  );
});

// Touch createDb/seedDb so the explicit-db helper variants stay imported even if
// a future refactor drops the TestDbLayer usages (keeps the lockstep DDL honest).
describe("schema lockstep", () => {
  it("createDb applies the deactivated_at column", () => {
    const db = createDb(":memory:");
    seedDb(db);
    const fam = aFamily(db);
    const [row] = db
      .select({ deactivatedAt: families.deactivatedAt })
      .from(families)
      .where(eq(families.id, fam.id))
      .all();
    expect(row!.deactivatedAt).toBeNull();
  });
});
