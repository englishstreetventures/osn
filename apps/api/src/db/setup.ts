import { Database } from "bun:sqlite"
import { drizzle } from "drizzle-orm/bun-sqlite"
import * as schema from "@cire/db"
import guestsData from "../data/guests.json"
import eventsData from "../data/events.json"
import type { Db } from "./index"

const DDL = `
CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  claim_code TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  location TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS guest_events (
  guest_id TEXT NOT NULL REFERENCES guests(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  PRIMARY KEY (guest_id, event_id)
);

CREATE TABLE IF NOT EXISTS rsvps (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id),
  event_id TEXT NOT NULL REFERENCES events(id),
  status TEXT NOT NULL CHECK(status IN ('attending', 'declined', 'maybe')),
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id),
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`

export function createDb(path: string = ":memory:"): Db {
  const sqlite = new Database(path)
  sqlite.exec(DDL)
  return drizzle(sqlite, { schema })
}

export function seedDb(db: Db): void {
  const now = new Date()
  const guestIdByName = new Map<string, string>()

  for (const guest of guestsData) {
    const id = crypto.randomUUID()
    guestIdByName.set(guest.name, id)
    db.insert(schema.guests)
      .values({
        id,
        name: guest.name,
        claimCode: guest.code,
        createdAt: now,
      })
      .run()
  }

  for (const [slug, event] of Object.entries(eventsData)) {
    db.insert(schema.events)
      .values({
        id: event.id,
        slug,
        name: event.name,
        date: event.date,
        location: event.location,
        description: event.description,
      })
      .run()

    for (const guestName of event.guests) {
      const guestId = guestIdByName.get(guestName)
      if (guestId) {
        db.insert(schema.guestEvents)
          .values({ guestId, eventId: event.id })
          .run()
      }
    }
  }
}
