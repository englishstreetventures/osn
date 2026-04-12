import { Database } from "bun:sqlite";

import * as schema from "@pulse/db/schema";
import { events, type Event } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { Effect, Layer } from "effect";

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
      visibility TEXT NOT NULL DEFAULT 'public',
      guest_list_visibility TEXT NOT NULL DEFAULT 'public',
      join_policy TEXT NOT NULL DEFAULT 'open',
      allow_interested INTEGER NOT NULL DEFAULT 1,
      comms_channels TEXT NOT NULL DEFAULT '["email"]',
      chat_id TEXT,
      created_by_user_id TEXT NOT NULL,
      created_by_name TEXT,
      created_by_avatar TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`CREATE INDEX events_visibility_idx ON events (visibility)`);
  sqlite.run(`
    CREATE TABLE event_rsvps (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      user_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'going',
      invited_by_user_id TEXT,
      created_at INTEGER NOT NULL,
      UNIQUE (event_id, user_id)
    )
  `);
  sqlite.run(`CREATE INDEX event_rsvps_event_idx ON event_rsvps (event_id)`);
  sqlite.run(`CREATE INDEX event_rsvps_user_idx ON event_rsvps (user_id)`);
  sqlite.run(`
    CREATE TABLE pulse_users (
      user_id TEXT PRIMARY KEY,
      attendance_visibility TEXT NOT NULL DEFAULT 'connections',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`
    CREATE TABLE event_comms (
      id TEXT PRIMARY KEY,
      event_id TEXT NOT NULL REFERENCES events(id),
      channel TEXT NOT NULL,
      body TEXT NOT NULL,
      sent_by_user_id TEXT NOT NULL,
      sent_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  sqlite.run(`CREATE INDEX event_comms_event_idx ON event_comms (event_id)`);
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
  visibility?: "public" | "private";
  guestListVisibility?: "public" | "connections" | "private";
  joinPolicy?: "open" | "guest_list";
  allowInterested?: boolean;
  commsChannels?: ("sms" | "email")[];
  chatId?: string;
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
      visibility: input.visibility ?? "public",
      guestListVisibility: input.guestListVisibility ?? "public",
      joinPolicy: input.joinPolicy ?? "open",
      allowInterested: input.allowInterested ?? true,
      commsChannels: JSON.stringify(input.commsChannels ?? ["email"]),
      chatId: input.chatId ?? null,
      createdByUserId: input.createdByUserId ?? "usr_alice",
      createdByName: input.createdByName ?? "Alice",
      createdByAvatar: input.createdByAvatar ?? null,
      createdAt: now,
      updatedAt: now,
    };
    yield* Effect.promise(() => db.insert(events).values(row));
    return row;
  });
