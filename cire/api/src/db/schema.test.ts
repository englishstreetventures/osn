import { describe, it, expect } from "bun:test";

import * as schema from "@cire/db";
import { families, guestAccountLinks, guests, weddingHosts } from "@cire/db";
import { eq } from "drizzle-orm";

import { createDb, seedBootstrapWedding } from "./setup";

// Constraint-behaviour tests for the schema (uniques, FKs, cascades,
// defaults). Runs on the primary setup.ts DDL mirror — the mini-mirror DDL
// that used to live here was a fourth lockstep surface and is gone; the
// mirror itself is pinned to the migration chain by ddl-lockstep.test.ts.
function makeDb() {
  const db = createDb();
  seedBootstrapWedding(db);
  return db;
}

const now = new Date();
const insertFamily = (
  db: ReturnType<typeof makeDb>,
  id: string,
  publicId: string,
  familyName: string,
) =>
  db
    .insert(families)
    .values({
      id,
      weddingId: "wed_bootstrap",
      publicId,
      familyName,
      createdAt: now,
      updatedAt: now,
    })
    .run();

describe("families schema", () => {
  it("rejects a duplicate public_id", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "MOCKTON-JOY-EE55", "Mockton");
    expect(() => {
      insertFamily(db, "fam-2", "MOCKTON-JOY-EE55", "Other");
    }).toThrow();
  });

  it("permits the same family_name for different families", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "TESTFOR-JOY-DD44", "Placeholder");
    insertFamily(db, "fam-2", "TESTFOR-SKY-FF66", "Placeholder");
    const rows = db.select().from(families).all();
    expect(rows).toHaveLength(2);
  });

  it("defaults kind to 'guest'", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "KINDDEF-IVY-AA11", "Defaulter");
    const [row] = db.select().from(families).all();
    expect(row?.kind).toBe("guest");
  });

  it("allows at most one host family per wedding (partial unique index)", () => {
    const db = makeDb();
    db.insert(families)
      .values({
        id: "fam-host-1",
        weddingId: "wed_bootstrap",
        publicId: "HOST-AAAAAAAAAAAA",
        familyName: "Host Preview",
        kind: "host",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(() => {
      db.insert(families)
        .values({
          id: "fam-host-2",
          weddingId: "wed_bootstrap",
          publicId: "HOST-BBBBBBBBBBBB",
          familyName: "Host Preview",
          kind: "host",
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }).toThrow();
  });

  it("does not constrain guest families by the host partial index", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "GUESTONE-IVY-AA11", "Guesty");
    insertFamily(db, "fam-2", "GUESTTWO-IVY-BB22", "Guesty");
    expect(db.select().from(families).all()).toHaveLength(2);
  });

  it("defaults deactivated_at to null (active) and round-trips a set value", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "DEACTDEF-IVY-AA11", "Active");
    const [active] = db.select().from(families).all();
    expect(active?.deactivatedAt).toBeNull();

    const when = new Date(1_700_000_000_000);
    db.update(families).set({ deactivatedAt: when }).where(eq(families.id, "fam-1")).run();
    const [deactivated] = db.select().from(families).all();
    expect(deactivated?.deactivatedAt?.getTime()).toBe(when.getTime());
  });
});

describe("wedding_hosts schema", () => {
  const insertHost = (
    db: ReturnType<typeof makeDb>,
    id: string,
    osnProfileId: string,
    addedBy = "usr_owner",
  ) =>
    db
      .insert(weddingHosts)
      .values({
        id,
        weddingId: "wed_bootstrap",
        osnProfileId,
        addedByOsnProfileId: addedBy,
        createdAt: now,
      })
      .run();

  it("defaults role to 'host'", () => {
    const db = makeDb();
    insertHost(db, "whost-1", "usr_alice");
    const [row] = db.select().from(weddingHosts).all();
    expect(row?.role).toBe("host");
  });

  it("rejects the same profile twice on one wedding (unique index)", () => {
    const db = makeDb();
    insertHost(db, "whost-1", "usr_alice");
    expect(() => insertHost(db, "whost-2", "usr_alice")).toThrow();
  });

  it("permits the same profile to co-host different weddings", () => {
    const db = makeDb();
    db.insert(schema.weddings)
      .values({
        id: "wed_two",
        slug: "two",
        displayName: "Two",
        ownerOsnProfileId: "usr_owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    insertHost(db, "whost-1", "usr_alice");
    db.insert(weddingHosts)
      .values({
        id: "whost-2",
        weddingId: "wed_two",
        osnProfileId: "usr_alice",
        addedByOsnProfileId: "usr_owner",
        createdAt: now,
      })
      .run();
    expect(db.select().from(weddingHosts).all()).toHaveLength(2);
  });

  it("rejects a host whose wedding_id does not exist (FK enforcement)", () => {
    const db = makeDb();
    expect(() =>
      db
        .insert(weddingHosts)
        .values({
          id: "whost-1",
          weddingId: "wed_missing",
          osnProfileId: "usr_alice",
          addedByOsnProfileId: "usr_owner",
          createdAt: now,
        })
        .run(),
    ).toThrow();
  });

  it("cascades deletion of a wedding to its host rows", () => {
    const db = makeDb();
    db.insert(schema.weddings)
      .values({
        id: "wed_doomed",
        slug: "doomed",
        displayName: "Doomed",
        ownerOsnProfileId: "usr_owner",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(weddingHosts)
      .values({
        id: "whost-1",
        weddingId: "wed_doomed",
        osnProfileId: "usr_alice",
        addedByOsnProfileId: "usr_owner",
        createdAt: now,
      })
      .run();
    expect(db.select().from(weddingHosts).all()).toHaveLength(1);
    db.delete(schema.weddings).where(eq(schema.weddings.id, "wed_doomed")).run();
    expect(db.select().from(weddingHosts).all()).toHaveLength(0);
  });
});

describe("guests schema", () => {
  it("cascades deletion of a family to its guests", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "TESTONE-IVY-AA11", "Testfamily");
    db.insert(guests)
      .values({
        id: "guest-1",
        familyId: "fam-1",
        firstName: "Ada",
        lastName: "Testfamily",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    expect(db.select().from(guests).all()).toHaveLength(1);

    db.delete(families).where(eq(families.id, "fam-1")).run();
    expect(db.select().from(guests).all()).toHaveLength(0);
  });

  it("rejects a guest whose family_id does not exist (FK enforcement)", () => {
    const db = makeDb();
    expect(() => {
      db.insert(guests)
        .values({
          id: "guest-1",
          familyId: "missing-family",
          firstName: "Orphan",
          lastName: "Guest",
          sortOrder: 0,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }).toThrow();
  });

  it("permits a nullable externalId for forward-looking spreadsheet IDs", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "TESTONE-IVY-AA11", "Testfamily");
    db.insert(guests)
      .values({
        id: "guest-1",
        familyId: "fam-1",
        firstName: "Ada",
        lastName: "Testfamily",
        sortOrder: 0,
        externalId: null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(guests)
      .values({
        id: "guest-2",
        familyId: "fam-1",
        firstName: "Raj",
        lastName: "Testfamily",
        sortOrder: 1,
        externalId: "SHEET-1234",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    const rows = db.select().from(guests).all();
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.firstName === "Ada")?.externalId).toBeNull();
    expect(rows.find((r) => r.firstName === "Raj")?.externalId).toBe("SHEET-1234");
  });
});

describe("guest_account_links schema", () => {
  function seedGuest(db: ReturnType<typeof makeDb>, familyId: string, guestId: string) {
    db.insert(guests)
      .values({
        id: guestId,
        familyId,
        firstName: "Inv",
        lastName: "Itee",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const link = (
    db: ReturnType<typeof makeDb>,
    overrides: Partial<typeof guestAccountLinks.$inferInsert>,
  ) =>
    db
      .insert(guestAccountLinks)
      .values({
        id: crypto.randomUUID(),
        guestId: "gst-1",
        familyId: "fam-1",
        weddingId: "wed_bootstrap",
        osnAccountId: "acc_1",
        osnProfileId: "usr_1",
        linkedAt: now,
        updatedAt: now,
        ...overrides,
      })
      .run();

  it("enforces one link per invitee (guest_id unique)", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "LINKONE-IVY-AA11", "Linkfamily");
    seedGuest(db, "fam-1", "gst-1");
    link(db, {});
    expect(() => link(db, { osnAccountId: "acc_2", osnProfileId: "usr_2" })).toThrow();
  });

  it("rejects the same OSN account claiming two seats in one family", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "LINKTWO-IVY-BB22", "Linkfamily");
    seedGuest(db, "fam-1", "gst-1");
    seedGuest(db, "fam-1", "gst-2");
    link(db, { guestId: "gst-1", osnAccountId: "acc_shared" });
    expect(() => link(db, { guestId: "gst-2", osnAccountId: "acc_shared" })).toThrow();
  });

  it("allows the same OSN account to link across different families", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "LINKTHR-IVY-CC33", "FamilyA");
    insertFamily(db, "fam-2", "LINKFOU-IVY-DD44", "FamilyB");
    seedGuest(db, "fam-1", "gst-1");
    seedGuest(db, "fam-2", "gst-2");
    link(db, { guestId: "gst-1", familyId: "fam-1", osnAccountId: "acc_shared" });
    link(db, { guestId: "gst-2", familyId: "fam-2", osnAccountId: "acc_shared" });
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(2);
  });

  it("cascades deletion of a guest to its account link", () => {
    const db = makeDb();
    insertFamily(db, "fam-1", "LINKFIV-IVY-EE55", "Linkfamily");
    seedGuest(db, "fam-1", "gst-1");
    link(db, {});
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(1);
    db.delete(guests).where(eq(guests.id, "gst-1")).run();
    expect(db.select().from(guestAccountLinks).all()).toHaveLength(0);
  });
});
