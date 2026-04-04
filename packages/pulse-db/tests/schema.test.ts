import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { eq } from "drizzle-orm";
import * as schema from "../src/schema";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      venue TEXT,
      category TEXT,
      start_time INTEGER NOT NULL,
      end_time INTEGER,
      status TEXT NOT NULL DEFAULT 'upcoming',
      image_url TEXT,
      latitude REAL,
      longitude REAL,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT,
      created_by_avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return drizzle(sqlite, { schema });
}

describe("events schema", () => {
  it("inserts and retrieves a row", async () => {
    const db = createTestDb();
    const now = new Date("2030-06-01T10:00:00.000Z");
    await db.insert(schema.events).values({
      id: "evt_test",
      title: "Schema Test",
      startTime: now,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });

    const rows = await db.select().from(schema.events).where(eq(schema.events.id, "evt_test"));
    expect(rows).toHaveLength(1);

    const row = rows[0]!;
    expect(row.id).toBe("evt_test");
    expect(row.title).toBe("Schema Test");
    expect(row.status).toBe("upcoming");
    expect(row.description).toBeNull();
    expect(row.startTime).toBeInstanceOf(Date);
    expect(row.startTime.toISOString()).toBe("2030-06-01T10:00:00.000Z");
  });

  it("startTime round-trips as Date via timestamp mode", async () => {
    const db = createTestDb();
    const ts = new Date("2026-04-01T12:00:00.000Z");
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_ts",
      title: "Timestamp Test",
      startTime: ts,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db.select().from(schema.events).where(eq(schema.events.id, "evt_ts"));
    expect(row!.startTime).toBeInstanceOf(Date);
    expect(row!.startTime.getTime()).toBe(ts.getTime());
  });

  it("optional fields default to null", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.events).values({
      id: "evt_nulls",
      title: "Null Test",
      startTime: now,
      createdByUserId: "usr_alice",
      createdAt: now,
      updatedAt: now,
    });

    const [row] = await db.select().from(schema.events).where(eq(schema.events.id, "evt_nulls"));
    expect(row!.description).toBeNull();
    expect(row!.location).toBeNull();
    expect(row!.venue).toBeNull();
    expect(row!.category).toBeNull();
    expect(row!.endTime).toBeNull();
    expect(row!.imageUrl).toBeNull();
    expect(row!.latitude).toBeNull();
    expect(row!.longitude).toBeNull();
    expect(row!.createdByName).toBeNull();
    expect(row!.createdByAvatar).toBeNull();
  });
});
