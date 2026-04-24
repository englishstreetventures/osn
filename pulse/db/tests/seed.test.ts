import { Database } from "bun:sqlite";

import { drizzle } from "drizzle-orm/bun-sqlite";
import { describe, it, expect } from "vitest";

import * as schema from "../src/schema";
import {
  buildSeedEvents,
  buildSeedRsvps,
  buildSeedSeries,
  buildSeedSeriesInstances,
} from "../src/seed";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run(`
    CREATE TABLE event_series (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      location TEXT,
      venue TEXT,
      latitude REAL,
      longitude REAL,
      category TEXT,
      image_url TEXT,
      duration_minutes INTEGER,
      visibility TEXT NOT NULL DEFAULT 'public',
      guest_list_visibility TEXT NOT NULL DEFAULT 'public',
      join_policy TEXT NOT NULL DEFAULT 'open',
      allow_interested INTEGER NOT NULL DEFAULT 1,
      comms_channels TEXT NOT NULL DEFAULT '["email"]',
      rrule TEXT NOT NULL,
      dtstart INTEGER NOT NULL,
      until INTEGER,
      materialized_through INTEGER NOT NULL,
      timezone TEXT NOT NULL DEFAULT 'UTC',
      status TEXT NOT NULL DEFAULT 'active',
      chat_id TEXT,
      created_by_profile_id TEXT NOT NULL,
      created_by_name TEXT,
      created_by_avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
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
      visibility TEXT NOT NULL DEFAULT 'public',
      guest_list_visibility TEXT NOT NULL DEFAULT 'public',
      join_policy TEXT NOT NULL DEFAULT 'open',
      allow_interested INTEGER NOT NULL DEFAULT 1,
      comms_channels TEXT NOT NULL DEFAULT '["email"]',
      chat_id TEXT,
      series_id TEXT REFERENCES event_series(id),
      instance_override INTEGER NOT NULL DEFAULT 0,
      created_by_profile_id TEXT,
      created_by_name TEXT,
      created_by_avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE event_rsvps (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      profile_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'going',
      invited_by_profile_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (event_id, profile_id)
    )
  `);
  return drizzle(sqlite, { schema });
}

describe("buildSeedEvents", () => {
  it("returns 15 events", () => {
    const rows = buildSeedEvents(new Date());
    expect(rows).toHaveLength(15);
  });

  it("status distribution: 2 finished, 4 ongoing, 9 upcoming", () => {
    const rows = buildSeedEvents(new Date());
    const counts = { finished: 0, ongoing: 0, upcoming: 0, cancelled: 0 };
    for (const r of rows) counts[r.status as keyof typeof counts]++;
    expect(counts.finished).toBe(2);
    expect(counts.ongoing).toBe(4);
    expect(counts.upcoming).toBe(9);
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

  it("all events have a createdByProfileId and createdByName", () => {
    const rows = buildSeedEvents(new Date());
    for (const r of rows) {
      expect(typeof r.createdByProfileId).toBe("string");
      expect(typeof r.createdByName).toBe("string");
    }
  });

  it("seed user IDs use stable usr_seed_* prefix", () => {
    const rows = buildSeedEvents(new Date());
    const ids = rows.map((r) => r.createdByProfileId).filter(Boolean);
    for (const id of ids) {
      expect(id).toMatch(/^usr_seed_/);
    }
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
    expect(rows).toHaveLength(15);
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

// ---------------------------------------------------------------------------
// buildSeedRsvps
// ---------------------------------------------------------------------------

describe("buildSeedRsvps", () => {
  it("returns 85 RSVPs (73 one-off + 12 series-instance)", () => {
    const rsvps = buildSeedRsvps();
    expect(rsvps).toHaveLength(85);
  });

  it("all IDs use rsvp_seed_ prefix", () => {
    for (const r of buildSeedRsvps()) {
      expect(r.id).toMatch(/^rsvp_seed_/);
    }
  });

  it("all eventIds reference a valid one-off event or series instance", () => {
    const now = new Date();
    const eventIds = new Set([
      ...buildSeedEvents(now).map((e) => e.id),
      ...buildSeedSeriesInstances(now).map((e) => e.id),
    ]);
    for (const r of buildSeedRsvps()) {
      expect(eventIds.has(r.eventId)).toBe(true);
    }
  });

  it("all profileIds use usr_seed_ prefix", () => {
    for (const r of buildSeedRsvps()) {
      expect(r.profileId).toMatch(/^usr_seed_/);
    }
  });

  it("no duplicate (eventId, profileId) pairs", () => {
    const pairs = new Set<string>();
    for (const r of buildSeedRsvps()) {
      const pair = `${r.eventId}:${r.profileId}`;
      expect(pairs.has(pair)).toBe(false);
      pairs.add(pair);
    }
  });

  it("status values are only 'going' or 'interested'", () => {
    for (const r of buildSeedRsvps()) {
      expect(["going", "interested"]).toContain(r.status);
    }
  });

  it("has both going and interested statuses", () => {
    const rsvps = buildSeedRsvps();
    expect(rsvps.some((r) => r.status === "going")).toBe(true);
    expect(rsvps.some((r) => r.status === "interested")).toBe(true);
  });
});

describe("RSVP seed idempotency", () => {
  it("inserting RSVPs twice does not duplicate rows", async () => {
    const db = createTestDb();
    const now = new Date();
    await db.insert(schema.eventSeries).values(buildSeedSeries(now)).onConflictDoNothing();
    const allEvents = [...buildSeedEvents(now), ...buildSeedSeriesInstances(now)];
    await db.insert(schema.events).values(allEvents).onConflictDoNothing();
    const rsvps = buildSeedRsvps();

    await db.insert(schema.eventRsvps).values(rsvps).onConflictDoNothing();
    await db.insert(schema.eventRsvps).values(rsvps).onConflictDoNothing();

    const rows = await db.select().from(schema.eventRsvps);
    expect(rows).toHaveLength(85);
  });
});

// ---------------------------------------------------------------------------
// buildSeedSeries + buildSeedSeriesInstances
// ---------------------------------------------------------------------------

describe("buildSeedSeries", () => {
  it("returns 2 series with srs_seed_* ids", () => {
    const series = buildSeedSeries(new Date());
    expect(series).toHaveLength(2);
    for (const s of series) expect(s.id).toMatch(/^srs_seed_/);
  });

  it("each series has a valid rrule and timezone", () => {
    for (const s of buildSeedSeries(new Date())) {
      expect(s.rrule.length).toBeGreaterThan(0);
      expect((s.timezone ?? "").length).toBeGreaterThan(0);
    }
  });
});

describe("buildSeedSeriesInstances", () => {
  it("produces 14 instances (8 yoga + 6 book club)", () => {
    expect(buildSeedSeriesInstances(new Date())).toHaveLength(14);
  });

  it("every instance has seriesId matching a seed series", () => {
    const now = new Date();
    const seriesIds = new Set(buildSeedSeries(now).map((s) => s.id));
    for (const i of buildSeedSeriesInstances(now)) {
      expect(seriesIds.has(i.seriesId!)).toBe(true);
    }
  });

  it("includes at least one overridden instance", () => {
    const overridden = buildSeedSeriesInstances(new Date()).filter((i) => i.instanceOverride);
    expect(overridden.length).toBeGreaterThan(0);
  });

  it("includes at least one cancelled instance", () => {
    const cancelled = buildSeedSeriesInstances(new Date()).filter((i) => i.status === "cancelled");
    expect(cancelled.length).toBeGreaterThan(0);
  });
});

describe("series seed idempotency", () => {
  it("inserting series + instances twice does not duplicate rows", async () => {
    const db = createTestDb();
    const now = new Date();
    const series = buildSeedSeries(now);
    const instances = buildSeedSeriesInstances(now);

    await db.insert(schema.eventSeries).values(series).onConflictDoNothing();
    await db.insert(schema.eventSeries).values(series).onConflictDoNothing();
    await db.insert(schema.events).values(instances).onConflictDoNothing();
    await db.insert(schema.events).values(instances).onConflictDoNothing();

    expect(await db.select().from(schema.eventSeries)).toHaveLength(2);
    expect(await db.select().from(schema.events)).toHaveLength(14);
  });
});
