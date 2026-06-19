import { Database } from "bun:sqlite";

import * as schema from "@cire/db";
import { drizzle } from "drizzle-orm/bun-sqlite";

import eventsData from "../data/events.json";
import guestsData from "../data/guests.json";
import type { Db } from "./index";

// Stable owner for the local-dev / test sample wedding. No real OSN profile
// exists in local dev or the test suite, so the seeded wedding is owned by this
// fixed dev id; sign in as it (or repoint via CIRE_DEV_OWNER_PROFILE_ID in the
// db:seed script) to see the sample wedding in the portal. Deployed tiers never
// run this seed — a real signed-in OSN user creates their own weddings via
// POST /api/organiser/weddings, so there is no env-driven owner resolution here.
export const DEV_OWNER_PROFILE_ID = "usr_dev_bootstrap_owner";

// LOCKSTEP CONTRACT: this DDL is a hand-maintained mirror of
// @cire/db's schema.ts + the latest migration in cire/db/migrations/.
// Tests run against THIS string, not the migration files — any schema
// change must update all three together or tests will pass on a shape
// production rejects. (A second mirror lives in src/db/schema.test.ts.)
export const DDL = `
CREATE TABLE IF NOT EXISTS weddings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  owner_osn_profile_id TEXT NOT NULL,
  code_style TEXT NOT NULL DEFAULT 'secure',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS weddings_owner_idx ON weddings(owner_osn_profile_id);

CREATE TABLE IF NOT EXISTS wedding_hosts (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  osn_profile_id TEXT NOT NULL,
  added_by_osn_profile_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'host',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wedding_hosts_wedding_profile_uniq ON wedding_hosts(wedding_id, osn_profile_id);
CREATE INDEX IF NOT EXISTS wedding_hosts_profile_idx ON wedding_hosts(osn_profile_id);
CREATE INDEX IF NOT EXISTS wedding_hosts_wedding_idx ON wedding_hosts(wedding_id);

CREATE TABLE IF NOT EXISTS families (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  public_id TEXT NOT NULL UNIQUE,
  family_name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'guest',
  code_shared_at INTEGER,
  first_opened_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS families_family_name_idx ON families(family_name);
CREATE INDEX IF NOT EXISTS families_wedding_idx ON families(wedding_id);
CREATE UNIQUE INDEX IF NOT EXISTS families_one_host_per_wedding ON families(wedding_id) WHERE kind = 'host';

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guests_family_id_idx ON guests(family_id);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  date TEXT NOT NULL,
  location TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL DEFAULT '',
  end_at TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT '',
  address TEXT,
  dress_code_description TEXT,
  dress_code_palette TEXT,
  pinterest_url TEXT,
  maps_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  event_image_key TEXT,
  event_image_crop TEXT
);
CREATE INDEX IF NOT EXISTS events_wedding_idx ON events(wedding_id);

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
  dietary_consent_at INTEGER,
  dietary_consent_version TEXT,
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

CREATE TABLE IF NOT EXISTS guest_account_links (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  osn_account_id TEXT NOT NULL,
  osn_profile_id TEXT NOT NULL,
  linked_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS guest_account_links_guest_uniq ON guest_account_links(guest_id);
CREATE UNIQUE INDEX IF NOT EXISTS guest_account_links_family_account_uniq ON guest_account_links(family_id, osn_account_id);
CREATE INDEX IF NOT EXISTS guest_account_links_account_idx ON guest_account_links(osn_account_id);
CREATE INDEX IF NOT EXISTS guest_account_links_family_idx ON guest_account_links(family_id);

CREATE TABLE IF NOT EXISTS wedding_invite_customisations (
  wedding_id TEXT PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  hero_title TEXT,
  hero_subtitle TEXT,
  story_eyebrow TEXT,
  story_heading TEXT,
  story_body TEXT,
  hero_image_key TEXT,
  story_image_key TEXT,
  hero_image_crop TEXT,
  story_image_crop TEXT,
  hero_blur INTEGER NOT NULL DEFAULT 28,
  hero_title_backdrop_opacity INTEGER NOT NULL DEFAULT 0,
  hero_title_backdrop_blur INTEGER NOT NULL DEFAULT 0,
  theme_heading_font TEXT,
  theme_body_font TEXT,
  hero_accent_color TEXT,
  hero_surface_color TEXT,
  story_accent_color TEXT,
  story_surface_color TEXT,
  details_accent_color TEXT,
  details_surface_color TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  uploaded_at INTEGER NOT NULL,
  format TEXT NOT NULL,
  events_r2_key TEXT NOT NULL,
  guests_r2_key TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  applied_at INTEGER,
  reverted_at INTEGER
);
CREATE INDEX IF NOT EXISTS imports_wedding_uploaded_at_idx ON imports(wedding_id, uploaded_at);
`;

export function createDb(path: string = ":memory:"): Db {
  const sqlite = new Database(path);
  // bun:sqlite does not enforce foreign keys by default — without this the
  // REFERENCES clauses above are inert and tests would pass on FK-violating
  // data that D1 (FKs always on) would reject.
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
}

// Sample wedding for local dev + the test suite — every seeded family/event is
// scoped to it. Owned by the fixed dev id (DEV_OWNER_PROFILE_ID); exported so
// tests that build their own fixtures on a bare createDb() can satisfy the
// wedding_id FK. This is the local/test path only — deployed D1 has no seeded
// wedding (migration 0015 removed the orphaned bootstrap row); real OSN users
// create their own weddings via POST /api/organiser/weddings.
export function seedBootstrapWedding(db: Db): void {
  const now = new Date();
  db.insert(schema.weddings)
    .values({
      id: schema.BOOTSTRAP_WEDDING_ID,
      slug: "cire-wedding",
      displayName: "Cire Wedding",
      ownerOsnProfileId: DEV_OWNER_PROFILE_ID,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

export function seedDb(db: Db): void {
  const now = new Date();
  const WEDDING_ID = schema.BOOTSTRAP_WEDDING_ID;

  seedBootstrapWedding(db);

  for (const event of Object.values(eventsData)) {
    db.insert(schema.events)
      .values({
        id: event.id,
        weddingId: WEDDING_ID,
        slug: event.slug,
        name: event.name,
        date: event.date,
        location: event.location,
        description: event.description,
        startAt: event.startAt,
        endAt: event.endAt,
        timezone: event.timezone,
        address: event.address,
        dressCodeDescription: event.dressCodeDescription,
        dressCodePalette: JSON.stringify(event.dressCodePalette),
        pinterestUrl: event.pinterestUrl,
        mapsUrl: event.mapsUrl,
        sortOrder: event.sortOrder,
      })
      .run();
  }

  for (const family of guestsData) {
    const familyId = crypto.randomUUID();

    db.insert(schema.families)
      .values({
        id: familyId,
        weddingId: WEDDING_ID,
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

      for (const eventId of guest.events) {
        db.insert(schema.guestEvents).values({ guestId, eventId }).run();
      }
    });
  }
}
