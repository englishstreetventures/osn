import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "@cire/db";
import guestsData from "../data/guests.json";
import eventsData from "../data/events.json";
import type { Db } from "./index";

const DDL = `
CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  public_id TEXT NOT NULL UNIQUE,
  family_name TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS families_family_name_idx ON families(family_name);

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guests_family_id_idx ON guests(family_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  location TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS guest_events (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id),
  PRIMARY KEY (guest_id, event_id)
);

CREATE TABLE IF NOT EXISTS rsvps (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id),
  status TEXT NOT NULL CHECK(status IN ('attending', 'declined', 'maybe')),
  dietary TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rsvps_guest_event_uniq ON rsvps(guest_id, event_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
`;

export function createDb(path: string = ":memory:"): Db {
  const sqlite = new Database(path);
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
}

export function seedDb(db: Db): void {
  const now = new Date();

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
      .run();
  }

  for (const family of guestsData) {
    const familyId = crypto.randomUUID();

    db.insert(schema.families)
      .values({
        id: familyId,
        publicId: family.publicId,
        familyName: family.familyName,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    family.guests.forEach((guest, index) => {
      const guestId = crypto.randomUUID();
      db.insert(schema.guests)
        .values({
          id: guestId,
          familyId,
          firstName: guest.firstName,
          lastName: guest.lastName,
          sortOrder: index,
          createdAt: now,
          updatedAt: now,
        })
        .run();

      for (const eventSlug of guest.events) {
        db.insert(schema.guestEvents).values({ guestId, eventId: eventSlug }).run();
      }
    });
  }
}
