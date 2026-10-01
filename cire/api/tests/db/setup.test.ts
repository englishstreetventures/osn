import { describe, expect, it } from "bun:test";

import * as schema from "@cire/db";
import { eq } from "drizzle-orm";

import { createDb, DDL, DEV_OWNER_SEAT_ID, seedDb } from "../../src/db/setup";

describe("multi-tenant schema", () => {
  it("seeds a bootstrap wedding and scopes families/events to it", () => {
    const db = createDb();
    seedDb(db);

    const weddings = db.select().from(schema.weddings).all();
    expect(weddings).toHaveLength(1);
    expect(weddings[0]!.id).toBe("wed_bootstrap");
    // Owned through a seat: the dev owner's, under its fixed id.
    const owners = db
      .select()
      .from(schema.weddingHosts)
      .where(eq(schema.weddingHosts.role, "owner"))
      .all();
    expect(owners.map((o) => [o.id, o.weddingId, o.osnProfileId])).toEqual([
      [DEV_OWNER_SEAT_ID, "wed_bootstrap", "usr_dev_bootstrap_owner"],
    ]);

    const families = db.select().from(schema.families).all();
    expect(families.length).toBeGreaterThan(0);
    for (const f of families) expect(f.weddingId).toBe("wed_bootstrap");

    const events = db.select().from(schema.events).all();
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.weddingId).toBe("wed_bootstrap");
  });

  it("rejects a family pointing at a missing wedding", () => {
    const db = createDb();
    seedDb(db);
    expect(() =>
      db
        .insert(schema.families)
        .values({
          id: "fam_orphan",
          weddingId: "wed_does_not_exist",
          publicId: "ORPHAN-1",
          familyName: "Orphan",
          createdAt: new Date(),
          updatedAt: new Date(),
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("cascades wedding delete to families", () => {
    const db = createDb();
    const now = new Date();
    db.insert(schema.weddings)
      .values({
        id: "wed_t",
        slug: "t",
        displayName: "T",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    db.insert(schema.families)
      .values({
        id: "fam_t",
        weddingId: "wed_t",
        publicId: "T-1",
        familyName: "T",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.delete(schema.weddings).where(eq(schema.weddings.id, "wed_t")).run();

    const survivors = db
      .select()
      .from(schema.families)
      .where(eq(schema.families.weddingId, "wed_t"))
      .all();
    expect(survivors).toHaveLength(0);
  });
});

// Composite-index drift guard for the raw DDL mirror. The Drizzle schema
// (@cire/db) declares events_wedding_id_sort_idx; this DDL string must keep
// mirroring it (and must not resurrect the dropped single-column pair) —
// the co-located @cire/db schema test pins the Drizzle side.
describe("DDL mirror", () => {
  it("declares the (wedding_id, sort_order) composite events index", () => {
    expect(DDL).toContain("events_wedding_id_sort_idx");
  });

  it("does not re-declare the dropped single-column events indexes", () => {
    expect(DDL).not.toContain("events_sort_order_idx");
    expect(DDL).not.toContain("events_wedding_idx ");
    // Guard the un-padded name too (e.g. followed by a newline or paren).
    expect(/events_wedding_idx\b/.test(DDL)).toBe(false);
  });
});
