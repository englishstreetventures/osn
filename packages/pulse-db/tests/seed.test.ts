import { describe, it, expect } from "vitest";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "../src/schema";
import { buildSeedEvents } from "../src/seed";

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
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return drizzle(sqlite, { schema });
}

describe("buildSeedEvents", () => {
  it("returns 9 events", () => {
    const rows = buildSeedEvents(new Date());
    expect(rows).toHaveLength(9);
  });

  it("status distribution: 1 finished, 3 ongoing, 5 upcoming", () => {
    const rows = buildSeedEvents(new Date());
    const counts = { finished: 0, ongoing: 0, upcoming: 0, cancelled: 0 };
    for (const r of rows) counts[r.status as keyof typeof counts]++;
    expect(counts.finished).toBe(1);
    expect(counts.ongoing).toBe(3);
    expect(counts.upcoming).toBe(5);
  });

  it("finished events: startTime and endTime are both in the past", () => {
    const now = new Date();
    const finished = buildSeedEvents(now).filter((r) => r.status === "finished");
    for (const r of finished) {
      expect(r.startTime.getTime()).toBeLessThan(now.getTime());
      expect(r.endTime!.getTime()).toBeLessThan(now.getTime());
    }
  });

  it("ongoing events: startTime is in the past, endTime is in the future", () => {
    const now = new Date();
    const ongoing = buildSeedEvents(now).filter((r) => r.status === "ongoing");
    for (const r of ongoing) {
      expect(r.startTime.getTime()).toBeLessThan(now.getTime());
      expect(r.endTime!.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("upcoming events: startTime is in the future", () => {
    const now = new Date();
    const upcoming = buildSeedEvents(now).filter((r) => r.status === "upcoming");
    for (const r of upcoming) {
      expect(r.startTime.getTime()).toBeGreaterThan(now.getTime());
    }
  });

  it("all events have stable evt_seed_* IDs", () => {
    const rows = buildSeedEvents(new Date());
    for (const r of rows) {
      expect(r.id).toMatch(/^evt_seed_/);
    }
  });

  it("all events have latitude and longitude", () => {
    const rows = buildSeedEvents(new Date());
    for (const r of rows) {
      expect(typeof r.latitude).toBe("number");
      expect(typeof r.longitude).toBe("number");
    }
  });

  it("all events have a category", () => {
    const rows = buildSeedEvents(new Date());
    const categories = rows.map((r) => r.category);
    expect(categories.every(Boolean)).toBe(true);
    // Covers the full spread of categories used for preference/discovery testing
    expect(new Set(categories).size).toBeGreaterThanOrEqual(7);
  });
});

describe("seed idempotency", () => {
  it("inserting twice does not duplicate rows", async () => {
    const db = createTestDb();
    const now = new Date();
    const seedData = buildSeedEvents(now);

    await db.insert(schema.events).values(seedData).onConflictDoNothing();
    await db.insert(schema.events).values(seedData).onConflictDoNothing();

    const rows = await db.select().from(schema.events);
    expect(rows).toHaveLength(9);
  });

  it("second insert does not throw", async () => {
    const db = createTestDb();
    const seedData = buildSeedEvents(new Date());

    await db.insert(schema.events).values(seedData).onConflictDoNothing();
    await expect(
      db.insert(schema.events).values(seedData).onConflictDoNothing(),
    ).resolves.not.toThrow();
  });
});
