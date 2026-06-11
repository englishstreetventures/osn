import { describe, expect, it } from "bun:test";

import * as schema from "@cire/db";
import { eq } from "drizzle-orm";

import { createDb, seedDb } from "./setup";

describe("multi-tenant schema", () => {
  it("seeds a bootstrap wedding and scopes families/events to it", () => {
    const db = createDb();
    seedDb(db);

    const weddings = db.select().from(schema.weddings).all();
    expect(weddings).toHaveLength(1);
    expect(weddings[0]!.id).toBe("wed_bootstrap");
    expect(weddings[0]!.ownerOsnProfileId).toBe("usr_REPLACE_BEFORE_PROD");

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
        ownerOsnProfileId: "usr_t",
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
