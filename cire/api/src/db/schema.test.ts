import { Database } from "bun:sqlite";
import { describe, it, expect } from "bun:test";

import * as schema from "@cire/db";
import { families, guestAccountLinks, guests } from "@cire/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

// LOCKSTEP CONTRACT: hand-maintained mini-mirror of @cire/db schema —
// keep in sync with schema.ts + migrations (primary mirror: setup.ts).
const DDL = `
CREATE TABLE weddings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  owner_osn_profile_id TEXT NOT NULL,
  code_style TEXT NOT NULL DEFAULT 'secure',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE families (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,
  family_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'guest',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX families_one_host_per_wedding ON families(wedding_id) WHERE kind = 'host';
CREATE TABLE guests (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE guest_account_links (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  osn_account_id TEXT NOT NULL,
  osn_profile_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX guest_account_links_guest_uniq ON guest_account_links(guest_id);
CREATE UNIQUE INDEX guest_account_links_family_account_uniq ON guest_account_links(family_id, osn_account_id);
CREATE INDEX guest_account_links_account_idx ON guest_account_links(osn_account_id);
CREATE INDEX guest_account_links_family_idx ON guest_account_links(family_id);
INSERT INTO weddings VALUES ('wed_bootstrap', 'cire-wedding', 'Cire Wedding', 'usr_REPLACE_BEFORE_PROD', 'secure', 0, 0);
`;

function makeDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
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
