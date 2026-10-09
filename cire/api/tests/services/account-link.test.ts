import { describe, it, expect } from "bun:test";

import { families, guestAccountLinks, guests, organiserSessions } from "@cire/db";
import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, driverErrorText, type Db } from "../../src/db";
import { createDb, type TestDb } from "../../src/db/setup";
import { accountLinkService, conflictReason } from "../../src/services/account-link";
import { failLikeD1 } from "../test-helpers";
import { seedOrganiserSession } from "../test-helpers/organiser-session";
import { insertWedding } from "../test-helpers/wedding";

const now = new Date();

/** Bare two-family fixture across two weddings — no JSON seed needed. */
function fixture(): TestDb {
  const db = createDb(":memory:");
  const seedWedding = (id: string, slug: string) =>
    insertWedding(db, {
      id,
      slug,
      displayName: id,
      createdAt: now,
      updatedAt: now,
      owners: ["usr_owner"],
    });
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

/** The household's linked seats, as the claim payload reports them. */
async function linkedIds(db: Db, familyId: string): Promise<string[]> {
  const state = await run(db, accountLinkService.householdState(familyId, null));
  return state.linkedGuestIds.toSorted();
}

function linkSeat(db: Db, familyId: string, guestId: string, osnAccountId: string) {
  return run(
    db,
    accountLinkService.link({ familyId, guestId, osnAccountId, osnProfileId: `usr_${guestId}` }),
  );
}

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
    // Assert the exact error channel — the route's 403 mapping keys off
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

  /**
   * A plus-one never holds the household's code: their row was typed in by the
   * member who brought them. Linking it would bind someone else's seat to the
   * account of whoever is signed in, so it is refused whichever client asks.
   */
  it("refuses to link a plus-one's seat, and writes no link", async () => {
    const db = fixture();
    db.insert(guests)
      .values({
        id: "gst_plus",
        familyId: "fam_a",
        firstName: "Sam",
        lastName: "",
        sortOrder: 0,
        plusOneOfGuestId: "gst_a1",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const err = await run(
      db,
      accountLinkService
        .link({
          familyId: "fam_a",
          guestId: "gst_plus",
          osnAccountId: "acc_1",
          osnProfileId: "usr_1",
        })
        .pipe(Effect.flip),
    );
    expect(err._tag).toBe("PlusOneSeatNotLinkable");
    expect(await run(db, accountLinkService.listByAccount("acc_1"))).toEqual([]);
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
    // Both conflicting indexes collapse to a single opaque reason.
    expect((dup as { reason: string }).reason).toBe("already_linked");

    // Same account, different seat in the same family → (family_id, account)
    // violation. This is INDISTINGUISHABLE from the guest_id conflict
    // above — same opaque reason — so a caller can't probe sibling-seat
    // membership of their own household.
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
    expect((seated as { reason: string }).reason).toBe("already_linked");
  });

  it("surfaces a non-conflict insert failure as AccountLinkWriteError (op: insert)", async () => {
    // Drop the table so the insert fails for a NON-unique reason
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

  it("logs a failed insert by its statement, never the database's text", async () => {
    // Failed as D1 fails it. The database's text here stands in for one that
    // quotes a bound value, as D1's own refusal to bind a value does.
    const db = fixture();
    failLikeD1(db);
    db.$client.exec(
      "CREATE TRIGGER gal_fail BEFORE INSERT ON guest_account_links BEGIN SELECT RAISE(ABORT, 'value Annabelle not supported'); END",
    );
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
    const { reason } = err as { reason: string };
    expect(reason).toContain('Failed query: insert into "guest_account_links"');
    expect(reason).not.toContain("Annabelle");
  });
});

// Pin the SQLite-message → reason mapping directly, independent of the
// driver's exact wording (the integration 409s depend on it).
//
// BOTH UNIQUE indexes map to the same opaque `already_linked` reason —
// the two cases must be indistinguishable (membership-oracle defence).
describe("conflictReason", () => {
  it("classifies the family+account UNIQUE index as the opaque reason", () => {
    expect(
      conflictReason(
        "UNIQUE constraint failed: guest_account_links.family_id, guest_account_links.osn_account_id",
      ),
    ).toBe("already_linked");
  });
  it("classifies the guest_id UNIQUE index as the SAME opaque reason", () => {
    expect(conflictReason("UNIQUE constraint failed: guest_account_links.guest_id")).toBe(
      "already_linked",
    );
  });
  it("returns null for a non-UNIQUE failure (→ 500, not 409)", () => {
    expect(conflictReason("SQLiteError: no such table: guest_account_links")).toBeNull();
    expect(conflictReason("FOREIGN KEY constraint failed")).toBeNull();
  });
  it("reads the database's wording, not the columns the statement names", () => {
    // On D1 the text read through `driverErrorText` opens with drizzle's
    // `Failed query: <statement>`, and the INSERT names `guest_id` and
    // `osn_account_id` whatever the conflict was on. A clash on the row id is
    // no link conflict.
    const db = fixture();
    const row = {
      id: "gal_1",
      guestId: "gst_a1",
      familyId: "fam_a",
      weddingId: "wed_a",
      osnAccountId: "acc_1",
      osnProfileId: "usr_1",
      linkedAt: now,
      updatedAt: now,
    };
    db.insert(guestAccountLinks).values(row).run();
    failLikeD1(db);
    let text = "";
    try {
      db.insert(guestAccountLinks)
        .values({ ...row, guestId: "gst_a2", osnAccountId: "acc_2" })
        .run();
    } catch (e) {
      text = driverErrorText(e);
    }

    expect(text).toContain('"guest_id"');
    expect(text).toContain("UNIQUE constraint failed: guest_account_links.id");
    expect(conflictReason(text)).toBeNull();
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
    expect(await linkedIds(db, "fam_a")).toEqual(["gst_a1"]);

    // Correct family removes it; a second removal still succeeds.
    await run(db, accountLinkService.unlink({ familyId: "fam_a", guestId: "gst_a1" }));
    await run(db, accountLinkService.unlink({ familyId: "fam_a", guestId: "gst_a1" }));
    expect(await linkedIds(db, "fam_a")).toEqual([]);
  });

  it("surfaces a delete failure as AccountLinkWriteError (op: delete)", async () => {
    // Drop the table so the delete throws — exercises the unlink 500 path.
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

describe("accountLinkService.householdState", () => {
  it("lists only this household's linked seats, and nothing about the accounts", async () => {
    const db = fixture();
    await linkSeat(db, "fam_a", "gst_a2", "acc_a2");
    await linkSeat(db, "fam_b", "gst_b1", "acc_b1");

    const state = await run(db, accountLinkService.householdState("fam_a", null));
    expect(state).toEqual({ enabled: true, signedIn: false, linkedGuestIds: ["gst_a2"] });
    // The account and profile ids stay server-side.
    expect(JSON.stringify(state)).not.toContain("acc_");
    expect(JSON.stringify(state)).not.toContain("usr_");
  });

  it("reports signed in only for a live OSN session", async () => {
    const db = fixture();
    const token = await seedOrganiserSession(db, "usr_guest");

    const live = await run(db, accountLinkService.householdState("fam_a", token));
    expect(live.signedIn).toBe(true);

    const unknown = await run(db, accountLinkService.householdState("fam_a", "not-a-session"));
    expect(unknown.signedIn).toBe(false);

    // Expired: the row is still there, but past its end.
    db.update(organiserSessions)
      .set({ expiresAt: new Date(Date.now() - 1_000) })
      .run();
    const expired = await run(db, accountLinkService.householdState("fam_a", token));
    expect(expired.signedIn).toBe(false);
  });
});
