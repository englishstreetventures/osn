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
import { applySchema } from "../src/testing";

function createTestDb() {
  const sqlite = new Database(":memory:");
  applySchema(sqlite);
  return drizzle(sqlite, { schema });
}

describe("buildSeedEvents", () => {
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
});

// ---------------------------------------------------------------------------
// buildSeedRsvps
// ---------------------------------------------------------------------------

describe("buildSeedRsvps", () => {
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

  it("no duplicate (eventId, profileId) pairs", () => {
    const pairs = new Set<string>();
    for (const r of buildSeedRsvps()) {
      const pair = `${r.eventId}:${r.profileId}`;
      expect(pairs.has(pair)).toBe(false);
      pairs.add(pair);
    }
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

describe("buildSeedSeriesInstances", () => {
  it("every instance has seriesId matching a seed series", () => {
    const now = new Date();
    const seriesIds = new Set(buildSeedSeries(now).map((s) => s.id));
    for (const i of buildSeedSeriesInstances(now)) {
      expect(seriesIds.has(i.seriesId!)).toBe(true);
    }
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
