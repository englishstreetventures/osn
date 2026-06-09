import { describe, it, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { imports } from "@cire/db";
import { createDb } from "./setup";

describe("imports table", () => {
  it("inserts and reads back an imports row in preview status", () => {
    const db = createDb(":memory:");
    const id = crypto.randomUUID();
    const uploadedAt = Date.now();
    const summary = JSON.stringify({ families: 12, guests: 38, events: 4 });

    db.insert(imports)
      .values({
        id,
        uploadedAt,
        format: "csv",
        eventsR2Key: `imports/${id}/events.csv`,
        guestsR2Key: `imports/${id}/guests.csv`,
        summary,
        status: "preview",
        appliedAt: null,
        revertedAt: null,
      })
      .run();

    const [row] = db.select().from(imports).where(eq(imports.id, id)).all();
    expect(row).toBeDefined();
    expect(row!.format).toBe("csv");
    expect(row!.status).toBe("preview");
    expect(row!.eventsR2Key).toBe(`imports/${id}/events.csv`);
    expect(row!.guestsR2Key).toBe(`imports/${id}/guests.csv`);
    expect(row!.uploadedAt).toBe(uploadedAt);
    expect(JSON.parse(row!.summary)).toEqual({ families: 12, guests: 38, events: 4 });
    expect(row!.appliedAt).toBeNull();
    expect(row!.revertedAt).toBeNull();
  });

  it("updates status to applied with appliedAt timestamp", () => {
    const db = createDb(":memory:");
    const id = crypto.randomUUID();
    const uploadedAt = Date.now();

    db.insert(imports)
      .values({
        id,
        uploadedAt,
        format: "tsv",
        eventsR2Key: "k1",
        guestsR2Key: "k2",
        summary: "{}",
        status: "preview",
      })
      .run();

    const appliedAt = Date.now();
    db.update(imports).set({ status: "applied", appliedAt }).where(eq(imports.id, id)).run();

    const [row] = db.select().from(imports).where(eq(imports.id, id)).all();
    expect(row!.status).toBe("applied");
    expect(row!.appliedAt).toBe(appliedAt);
  });
});
