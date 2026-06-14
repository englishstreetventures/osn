import { describe, it, expect } from "bun:test";

import { families, guests, weddings } from "@cire/db";
import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, type Db } from "../db";
import { createDb } from "../db/setup";
import { accountLinkService, conflictReason } from "./account-link";

const now = new Date();

/** Bare two-family fixture across two weddings — no JSON seed needed. */
function fixture(): Db {
  const db = createDb(":memory:");
  const seedWedding = (id: string, slug: string) =>
    db
      .insert(weddings)
      .values({
        id,
        slug,
        displayName: id,
        ownerOsnProfileId: "usr_owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  const seedFamily = (id: string, weddingId: string, publicId: string) =>
    db
      .insert(families)
      .values({ id, weddingId, publicId, familyName: id, createdAt: now, updatedAt: now })
      .run();
  const seedGuest = (id: string, familyId: string) =>
    db
      .insert(guests)
      .values({
        id,
        familyId,
        firstName: id,
        lastName: "X",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

  seedWedding("wed_a", "wed-a");
  seedWedding("wed_b", "wed-b");
  seedFamily("fam_a", "wed_a", "AAA-AAA-0001");
  seedFamily("fam_b", "wed_b", "BBB-BBB-0002");
  seedGuest("gst_a1", "fam_a");
  seedGuest("gst_a2", "fam_a");
  seedGuest("gst_b1", "fam_b");
  return db;
}

const run = <A, E>(db: Db, eff: Effect.Effect<A, E, DbService>): Promise<A> =>
  Effect.runPromise(eff.pipe(Effect.provideService(DbService, db)));

describe("accountLinkService.link", () => {
  it("derives the wedding id from the guest's family", async () => {
    const db = fixture();
    await run(
      db,
      accountLinkService.link({
        familyId: "fam_a",
        guestId: "gst_a1",
        osnAccountId: "acc_1",
        osnProfileId: "usr_1",
      }),
    );
    const links = await run(db, accountLinkService.listByAccount("acc_1"));
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ guestId: "gst_a1", familyId: "fam_a", weddingId: "wed_a" });
  });

  it("fails with the GuestNotInFamily tag when the guest is in a different family", async () => {
    const db = fixture();
    // T-E1: assert the exact error channel — the route's 403 mapping keys off
    // this tag, so a swap to a different tagged error must fail the test.
    const err = await run(
      db,
      accountLinkService
        .link({
          familyId: "fam_a",
          guestId: "gst_b1",
          osnAccountId: "acc_1",
          osnProfileId: "usr_1",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("GuestNotInFamily");
  });

  it("maps the two UNIQUE violations to the right AccountLinkConflict reason", async () => {
    const db = fixture();
    const link = (guestId: string, osnAccountId: string) =>
      run(
        db,
        accountLinkService.link({
          familyId: "fam_a",
          guestId,
          osnAccountId,
          osnProfileId: "usr_1",
        }),
      );
    await link("gst_a1", "acc_1");

    // Same invitee linked again → guest_id unique violation.
    const dup = await run(
      db,
      accountLinkService
        .link({
          familyId: "fam_a",
          guestId: "gst_a1",
          osnAccountId: "acc_2",
          osnProfileId: "usr_2",
        })
        .pipe(Effect.flip),
    );
    expect(dup._tag).toBe("AccountLinkConflict");
    expect((dup as { reason: string }).reason).toBe("guest_already_linked");

    // Same account, different seat in the same family → (family_id, account) violation.
    const seated = await run(
      db,
      accountLinkService
        .link({
          familyId: "fam_a",
          guestId: "gst_a2",
          osnAccountId: "acc_1",
          osnProfileId: "usr_3",
        })
        .pipe(Effect.flip),
    );
    expect(seated._tag).toBe("AccountLinkConflict");
    expect((seated as { reason: string }).reason).toBe("account_already_in_family");
  });

  it("surfaces a non-conflict insert failure as AccountLinkWriteError (op: insert)", async () => {
    // T-S1: drop the table so the insert fails for a NON-unique reason
    // (`conflictReason` returns null) — exercises the 500 path, not the 409 one.
    const db = fixture();
    db.run(sql`DROP TABLE guest_account_links`);
    const err = await run(
      db,
      accountLinkService
        .link({
          familyId: "fam_a",
          guestId: "gst_a1",
          osnAccountId: "acc_1",
          osnProfileId: "usr_1",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("AccountLinkWriteError");
    expect((err as { op: string }).op).toBe("insert");
  });
});

// T-S2: pin the SQLite-message → reason mapping directly, independent of the
// driver's exact wording (the integration 409s depend on it).
describe("conflictReason", () => {
  it("classifies the family+account UNIQUE index", () => {
    expect(
      conflictReason(
        "UNIQUE constraint failed: guest_account_links.family_id, guest_account_links.osn_account_id",
      ),
    ).toBe("account_already_in_family");
  });
  it("classifies the guest_id UNIQUE index", () => {
    expect(conflictReason("UNIQUE constraint failed: guest_account_links.guest_id")).toBe(
      "guest_already_linked",
    );
  });
  it("returns null for a non-UNIQUE failure (→ 500, not 409)", () => {
    expect(conflictReason("SQLiteError: no such table: guest_account_links")).toBeNull();
    expect(conflictReason("FOREIGN KEY constraint failed")).toBeNull();
  });
});

describe("accountLinkService.listByAccount", () => {
  it("returns every linked invitee for an account across weddings", async () => {
    const db = fixture();
    await run(
      db,
      accountLinkService.link({
        familyId: "fam_a",
        guestId: "gst_a1",
        osnAccountId: "acc_shared",
        osnProfileId: "usr_1",
      }),
    );
    await run(
      db,
      accountLinkService.link({
        familyId: "fam_b",
        guestId: "gst_b1",
        osnAccountId: "acc_shared",
        osnProfileId: "usr_1",
      }),
    );

    const links = await run(db, accountLinkService.listByAccount("acc_shared"));
    expect(links.map((l) => l.weddingId).toSorted()).toEqual(["wed_a", "wed_b"]);
    expect(await run(db, accountLinkService.listByAccount("acc_none"))).toHaveLength(0);
  });
});

describe("accountLinkService.unlink", () => {
  it("is idempotent and household-scoped", async () => {
    const db = fixture();
    await run(
      db,
      accountLinkService.link({
        familyId: "fam_a",
        guestId: "gst_a1",
        osnAccountId: "acc_1",
        osnProfileId: "usr_1",
      }),
    );
    // Wrong family can't remove it.
    await run(db, accountLinkService.unlink({ familyId: "fam_b", guestId: "gst_a1" }));
    expect(await run(db, accountLinkService.listByFamily("fam_a"))).toHaveLength(1);

    // Correct family removes it; a second removal still succeeds.
    await run(db, accountLinkService.unlink({ familyId: "fam_a", guestId: "gst_a1" }));
    await run(db, accountLinkService.unlink({ familyId: "fam_a", guestId: "gst_a1" }));
    expect(await run(db, accountLinkService.listByFamily("fam_a"))).toHaveLength(0);
  });

  it("surfaces a delete failure as AccountLinkWriteError (op: delete)", async () => {
    // T-S1: drop the table so the delete throws — exercises the unlink 500 path.
    const db = fixture();
    db.run(sql`DROP TABLE guest_account_links`);
    const err = await run(
      db,
      accountLinkService.unlink({ familyId: "fam_a", guestId: "gst_a1" }).pipe(Effect.flip),
    );
    expect(err._tag).toBe("AccountLinkWriteError");
    expect((err as { op: string }).op).toBe("delete");
  });
});
