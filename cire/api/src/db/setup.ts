import { Database } from "bun:sqlite";

import * as schema from "@cire/db";
import { DEV_OWNER_PROFILE_ID, events as eventsData, guests as guestsData } from "@cire/db/seed";
import { drizzle } from "drizzle-orm/bun-sqlite";

import type { Db } from "./index";

// Re-exported for the seed path + tests. The single source of truth lives in
// cire/db/seed/data/wedding.ts (DEV_OWNER_PROFILE_ID) — see seedBootstrapWedding
// below. No real OSN profile exists in local dev or the test suite, so the
// seeded wedding is owned by this fixed dev id; sign in as it (or repoint via
// CIRE_DEV_OWNER_PROFILE_ID in the db:seed script) to see the sample wedding in
// the portal. Deployed tiers never run this seed — a real signed-in OSN user
// creates their own weddings via POST /api/organiser/weddings.
export { DEV_OWNER_PROFILE_ID };

// LOCKSTEP CONTRACT: this DDL is a hand-maintained mirror of
// @cire/db's schema.ts + the latest migration in cire/db/migrations/.
// Tests run against THIS string, not the migration files — any schema
// change must update all three together or tests will pass on a shape
// production rejects. Enforced mechanically by src/db/ddl-lockstep.test.ts
// (T-S1), which diffs this DDL and the Drizzle schema against the full
// migration chain.
//
// No `--` comments inside the string: d1-integration.test.ts splits it on `;`
// and prepares each chunk, and miniflare rejects a chunk whose leading lines
// are a comment ("SQL code did not contain a statement"). Explain a table here
// in JS, or in its migration file.
export const DDL = `
CREATE TABLE IF NOT EXISTS weddings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  owner_osn_profile_id TEXT NOT NULL,
  code_style TEXT NOT NULL DEFAULT 'secure',
  wedding_date TEXT,
  guest_count_estimate INTEGER,
  currency TEXT NOT NULL DEFAULT 'AUD',
  budget_total_minor INTEGER,
  rsvp_deadline TEXT,
  rsvp_deadline_timezone TEXT,
  updated_by_osn_profile_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS weddings_owner_idx ON weddings(owner_osn_profile_id);
CREATE INDEX IF NOT EXISTS weddings_created_at_idx ON weddings(created_at);

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
  deactivated_at INTEGER,
  source TEXT NOT NULL DEFAULT 'import',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS families_wedding_idx ON families(wedding_id);
CREATE UNIQUE INDEX IF NOT EXISTS families_one_host_per_wedding ON families(wedding_id) WHERE kind = 'host';

CREATE TABLE IF NOT EXISTS guests (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL DEFAULT '',
  nickname TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  external_id TEXT,
  source TEXT NOT NULL DEFAULT 'import',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS guests_family_id_sort_idx ON guests(family_id, sort_order);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  address TEXT,
  dress_code_description TEXT,
  dress_code_palette TEXT,
  pinterest_url TEXT,
  maps_url TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  event_image_key TEXT,
  event_image_crop TEXT,
  created_at INTEGER,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS events_wedding_id_sort_idx ON events(wedding_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS events_wedding_slug_unique ON events(wedding_id, slug);

CREATE TABLE IF NOT EXISTS guest_events (
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  PRIMARY KEY (guest_id, event_id)
);
CREATE INDEX IF NOT EXISTS guest_events_event_id_idx ON guest_events(event_id);

CREATE TABLE IF NOT EXISTS rsvps (
  id TEXT PRIMARY KEY,
  guest_id TEXT NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  dietary TEXT NOT NULL DEFAULT '',
  dietary_consent_at INTEGER,
  dietary_consent_version TEXT,
  consent_source TEXT NOT NULL DEFAULT 'guest',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS rsvps_guest_event_uniq ON rsvps(guest_id, event_id);
CREATE INDEX IF NOT EXISTS rsvps_event_id_idx ON rsvps(event_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions(family_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS organiser_sessions (
  id TEXT PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  osn_profile_id TEXT NOT NULL,
  osn_sub TEXT NOT NULL,
  email TEXT,
  handle TEXT,
  display_name TEXT,
  avatar_url TEXT,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS organiser_sessions_profile_idx ON organiser_sessions(osn_profile_id);
CREATE INDEX IF NOT EXISTS organiser_sessions_expires_idx ON organiser_sessions(expires_at);

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
  details_eyebrow TEXT,
  details_heading TEXT,
  welcome_message TEXT,
  footer_message TEXT,
  hero_image_key TEXT,
  story_image_key TEXT,
  footer_image_key TEXT,
  hero_image_crop TEXT,
  story_image_crop TEXT,
  footer_image_crop TEXT,
  hero_image_crop_mobile TEXT,
  hero_blur INTEGER NOT NULL DEFAULT 28,
  hero_title_backdrop_opacity INTEGER NOT NULL DEFAULT 0,
  hero_title_backdrop_blur INTEGER NOT NULL DEFAULT 0,
  theme_heading_font TEXT,
  theme_body_font TEXT,
  theme_heading_size TEXT,
  theme_heading_weight TEXT,
  theme_heading_style TEXT,
  theme_body_weight TEXT,
  theme_body_style TEXT,
  palette_preset TEXT,
  palette_ground TEXT,
  palette_card TEXT,
  palette_ink TEXT,
  palette_gilt TEXT,
  palette_bloom TEXT,
  hero_tone TEXT,
  story_tone TEXT,
  details_tone TEXT,
  welcome_tone TEXT,
  invite_message TEXT,
  design_id TEXT NOT NULL DEFAULT 'classic',
  updated_at INTEGER NOT NULL,
  images_updated_at INTEGER,
  registry_eyebrow TEXT,
  registry_heading TEXT,
  registry_body TEXT,
  registry_tone TEXT
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
  reverted_at INTEGER,
  kind TEXT NOT NULL DEFAULT 'import',
  before_events_r2_key TEXT,
  before_guests_r2_key TEXT
);
CREATE INDEX IF NOT EXISTS imports_wedding_uploaded_at_idx ON imports(wedding_id, uploaded_at);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  timeframe_bucket TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_wedding_bucket_sort_idx ON tasks(wedding_id, timeframe_bucket, sort_order);

CREATE TABLE IF NOT EXISTS budget_items (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  estimate_minor INTEGER,
  quoted_minor INTEGER,
  actual_minor INTEGER,
  notes TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS budget_items_wedding_category_sort_idx ON budget_items(wedding_id, category, sort_order);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  budget_item_id TEXT NOT NULL REFERENCES budget_items(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  due_at TEXT,
  paid_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS payments_item_idx ON payments(budget_item_id);
CREATE TABLE IF NOT EXISTS directory_vendors (
  id TEXT PRIMARY KEY,
  owner_org_id TEXT,
  name TEXT NOT NULL,
  description TEXT,
  email TEXT,
  phone TEXT,
  website TEXT,
  instagram TEXT,
  location_text TEXT,
  price_band TEXT,
  price_min_minor INTEGER,
  price_max_minor INTEGER,
  listed TEXT NOT NULL DEFAULT 'draft',
  lead_forward_email TEXT,
  claimed_by_profile_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS directory_vendors_owner_idx ON directory_vendors(owner_org_id);
CREATE INDEX IF NOT EXISTS directory_vendors_listed_name_idx ON directory_vendors(listed, name, id);
CREATE TABLE IF NOT EXISTS directory_vendor_categories (
  directory_vendor_id TEXT NOT NULL REFERENCES directory_vendors(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  PRIMARY KEY (directory_vendor_id, category)
);
CREATE TABLE IF NOT EXISTS vendors (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  directory_vendor_id TEXT,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'researching',
  contact_name TEXT,
  email TEXT,
  phone TEXT,
  notes TEXT,
  quoted_minor INTEGER,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS vendors_wedding_status_idx ON vendors(wedding_id, status, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS vendors_wedding_directory_uniq ON vendors(wedding_id, directory_vendor_id) WHERE directory_vendor_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS vendor_claims (
  id TEXT PRIMARY KEY,
  directory_vendor_id TEXT NOT NULL REFERENCES directory_vendors(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX IF NOT EXISTS vendor_claims_vendor_idx ON vendor_claims(directory_vendor_id);
CREATE TABLE IF NOT EXISTS vendor_enquiries (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  directory_vendor_id TEXT NOT NULL,
  vendor_id TEXT NOT NULL REFERENCES vendors(id) ON DELETE CASCADE,
  zap_chat_id TEXT,
  pending_body TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT NOT NULL,
  quoted_minor INTEGER,
  last_message_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_enquiries_wedding_directory_uniq ON vendor_enquiries(wedding_id, directory_vendor_id);
CREATE INDEX IF NOT EXISTS vendor_enquiries_wedding_last_msg_idx ON vendor_enquiries(wedding_id, last_message_at);
CREATE INDEX IF NOT EXISTS vendor_enquiries_directory_idx ON vendor_enquiries(directory_vendor_id);
CREATE TABLE IF NOT EXISTS wedding_entitlements (
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  entitlement TEXT NOT NULL,
  source TEXT NOT NULL,
  granted_at INTEGER NOT NULL,
  granted_by TEXT NOT NULL,
  provider_ref TEXT,
  PRIMARY KEY (wedding_id, entitlement)
);
CREATE TABLE IF NOT EXISTS registry_settings (
  wedding_id TEXT PRIMARY KEY REFERENCES weddings(id) ON DELETE CASCADE,
  published INTEGER NOT NULL DEFAULT 0,
  headline TEXT,
  message TEXT,
  cash_gifts_enabled INTEGER NOT NULL DEFAULT 0,
  shipping_address TEXT,
  shipping_visible_from TEXT,
  stripe_account_id TEXT,
  stripe_charges_enabled INTEGER NOT NULL DEFAULT 0,
  stripe_payouts_enabled INTEGER NOT NULL DEFAULT 0,
  stripe_account_updated_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registry_items (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'product',
  title TEXT NOT NULL,
  description TEXT,
  image_key TEXT,
  image_crop TEXT,
  external_url TEXT,
  price_minor INTEGER,
  quantity_wanted INTEGER NOT NULL DEFAULT 1,
  allow_partial INTEGER NOT NULL DEFAULT 0,
  target_minor INTEGER,
  category TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT registry_items_quantity_wanted_ck CHECK (quantity_wanted >= 1),
  CONSTRAINT registry_items_kind_ck CHECK (kind in ('product','cash_fund'))
);
CREATE INDEX IF NOT EXISTS registry_items_wedding_sort_idx ON registry_items(wedding_id, sort_order, id);
CREATE TABLE IF NOT EXISTS registry_claims (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES registry_items(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'reserved',
  note TEXT,
  display_name TEXT,
  thanked_at INTEGER,
  thanked_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT registry_claims_quantity_ck CHECK (quantity >= 1 and quantity <= 99),
  CONSTRAINT registry_claims_status_ck CHECK (status in ('reserved','purchased','released'))
);
CREATE UNIQUE INDEX IF NOT EXISTS registry_claims_item_family_uniq ON registry_claims(item_id, family_id);
CREATE INDEX IF NOT EXISTS registry_claims_wedding_created_idx ON registry_claims(wedding_id, created_at);
CREATE INDEX IF NOT EXISTS registry_claims_item_status_idx ON registry_claims(item_id, status, family_id, quantity);
CREATE INDEX IF NOT EXISTS registry_claims_wedding_item_status_idx ON registry_claims(wedding_id, item_id, status, quantity);
CREATE TABLE IF NOT EXISTS registry_contributions (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES registry_items(id) ON DELETE SET NULL,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  primary_amount_minor INTEGER,
  primary_currency TEXT,
  fx_rate TEXT,
  fx_rate_at INTEGER,
  stripe_checkout_session_id TEXT NOT NULL UNIQUE,
  stripe_payment_intent_id TEXT,
  message TEXT,
  display_name TEXT,
  thanked_at INTEGER,
  thanked_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_contributions_wedding_created_idx ON registry_contributions(wedding_id, created_at);
CREATE INDEX IF NOT EXISTS registry_contributions_item_idx ON registry_contributions(item_id);
`;

export function createDb(path: string = ":memory:") {
  const sqlite = new Database(path);
  // bun:sqlite does not enforce foreign keys by default — without this the
  // REFERENCES clauses above are inert and tests would pass on FK-violating
  // data that D1 (FKs always on) would reject.
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec(DDL);
  return drizzle(sqlite, { schema });
}

// The precise sync-only shape createDb() returns — narrower than the
// production Db union (which must also cover D1's async driver). Test-local
// helpers that only ever see a createDb() handle should take this, not Db,
// so .all()/.get() keep their sync return types inside the helper body.
export type TestDb = ReturnType<typeof createDb>;

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
