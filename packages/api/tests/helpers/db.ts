import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";
import * as schema from "@pulse/db/schema";
import { events, type Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";

export function createTestLayer() {
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
  sqlite.run(`
    CREATE TABLE event_rsvps (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'going',
      created_at INTEGER NOT NULL,
      UNIQUE (event_id, user_id)
    )
  `);
  sqlite.run(`CREATE INDEX event_rsvps_event_idx ON event_rsvps (event_id)`);
  sqlite.run(`CREATE INDEX event_rsvps_user_idx ON event_rsvps (user_id)`);
  const db = drizzle(sqlite, { schema });
  return Layer.succeed(Db, { db });
}

/**
 * Insert an event directly into the DB, bypassing service-layer validation.
 * Used by tests that need events with past startTime (e.g. transition tests).
 */
export interface SeedEventInput {
  title: string;
  startTime: string | Date;
  endTime?: string | Date;
  status?: "upcoming" | "ongoing" | "finished" | "cancelled";
  category?: string;
  createdByUserId?: string;
  createdByName?: string | null;
  createdByAvatar?: string | null;
}

export const seedEvent = (input: SeedEventInput): Effect.Effect<Event, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const id = "evt_" + crypto.randomUUID().replace(/-/g, "").slice(0, 12);
    const now = new Date();
    const row: Event = {
      id,
      title: input.title,
      description: null,
      location: null,
      venue: null,
      latitude: null,
      longitude: null,
      category: input.category ?? null,
      startTime: new Date(input.startTime),
      endTime: input.endTime ? new Date(input.endTime) : null,
      status: input.status ?? "upcoming",
      imageUrl: null,
      createdByUserId: input.createdByUserId ?? "usr_alice",
      createdByName: input.createdByName ?? "Alice",
      createdByAvatar: input.createdByAvatar ?? null,
      createdAt: now,
      updatedAt: now,
    };
    yield* Effect.promise(() => db.insert(events).values(row));
    return row;
  });
