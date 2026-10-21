import { Database } from "bun:sqlite";

import * as schema from "@cire/db";
import {
  DEV_OWNER_PROFILE_ID,
  DEV_OWNER_SEAT_ID,
  events as eventsData,
  guests as guestsData,
} from "@cire/db/seed";
import { and, eq, ne } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";

import { DEFAULT_RSVP_DEADLINE_TIMEZONE, resolveRsvpDeadline } from "../lib/rsvp-deadline";
import type { Db } from "./index";

// Re-exported for the seed path + tests. The single source of truth lives in
// cire/db/seed/data/wedding.ts (DEV_OWNER_PROFILE_ID, DEV_OWNER_SEAT_ID) — see
// seedBootstrapWedding below. No real OSN profile exists in local dev or the
// test suite, so the seeded wedding's owner seat is held by this fixed dev id;
// sign in as it (or repoint the seat via CIRE_DEV_OWNER_PROFILE_ID) to see the
// sample wedding in the portal. Deployed tiers never run this seed — a real
// signed-in OSN user creates their own weddings via POST /api/organiser/weddings.
export { DEV_OWNER_PROFILE_ID, DEV_OWNER_SEAT_ID };

// LOCKSTEP CONTRACT: this DDL is a hand-maintained mirror of
// @cire/db's schema.ts + the latest migration in cire/db/migrations/.
// Tests run against THIS string, not the migration files — any schema
// change must update all three together or tests will pass on a shape
// production rejects. Enforced mechanically by tests/db/ddl-lockstep.test.ts,
// which diffs this DDL and the Drizzle schema against the full migration chain.
//
// No `--` comments inside the string: d1-integration.test.ts splits it on `;`
// and prepares each chunk, and miniflare rejects a chunk whose leading lines
// are a comment ("SQL code did not contain a statement"). Explain a table here
// in JS, or in its migration file.
//
// `tasks.assigned_host_id` and its index are here and in the migrations but
// not in the Drizzle schema, so no statement the app sends names them; only the
// Worker before migration 0091 reads and writes the column, if it serves again.
// Dropped by englishstreetventures/osn#1636.
export const DDL = `
CREATE TABLE IF NOT EXISTS weddings (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  code_style TEXT NOT NULL DEFAULT 'secure',
  wedding_date TEXT,
  guest_count_estimate INTEGER,
  currency TEXT NOT NULL DEFAULT 'AUD',
  budget_total_minor INTEGER,
  rsvp_deadline TEXT,
  rsvp_deadline_timezone TEXT,
  updated_by_osn_profile_id TEXT,
  change_rev INTEGER NOT NULL DEFAULT 0,
  change_claim TEXT,
  change_claimed_at INTEGER,
  tier TEXT NOT NULL DEFAULT 'ivory',
  tier_source TEXT,
  tier_granted_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER,
  deleted_by_osn_profile_id TEXT
);
CREATE INDEX IF NOT EXISTS weddings_created_at_idx ON weddings(created_at);
CREATE INDEX IF NOT EXISTS weddings_deleted_at_idx ON weddings(deleted_at) WHERE deleted_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS wedding_hosts (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  osn_profile_id TEXT NOT NULL,
  added_by_osn_profile_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'host',
  run_sheet_scope TEXT NOT NULL DEFAULT 'own',
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS wedding_hosts_wedding_profile_uniq ON wedding_hosts(wedding_id, osn_profile_id);
CREATE INDEX IF NOT EXISTS wedding_hosts_profile_idx ON wedding_hosts(osn_profile_id);
CREATE INDEX IF NOT EXISTS wedding_hosts_wedding_idx ON wedding_hosts(wedding_id);
CREATE UNIQUE INDEX IF NOT EXISTS wedding_hosts_id_wedding_unique ON wedding_hosts(id, wedding_id);

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
  plus_one_allowed INTEGER NOT NULL DEFAULT 0,
  plus_one_of_guest_id TEXT REFERENCES guests(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  email TEXT,
  email_source TEXT,
  email_consent_at INTEGER,
  email_consent_version TEXT,
  email_attested_by_osn_profile_id TEXT
);
CREATE INDEX IF NOT EXISTS guests_family_id_sort_idx ON guests(family_id, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS guests_plus_one_of_uniq ON guests(plus_one_of_guest_id) WHERE plus_one_of_guest_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS email_suppressions (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  email_hash TEXT NOT NULL,
  guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS email_suppressions_seat_uniq ON email_suppressions(wedding_id, email_hash, guest_id);
CREATE INDEX IF NOT EXISTS email_suppressions_guest_idx ON email_suppressions(guest_id) WHERE guest_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  timezone TEXT NOT NULL,
  venue_name TEXT,
  address TEXT,
  getting_there TEXT,
  children_policy TEXT,
  plus_one_policy TEXT,
  guest_policy_note TEXT,
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
CREATE UNIQUE INDEX IF NOT EXISTS events_id_wedding_uniq ON events(id, wedding_id);

CREATE TABLE IF NOT EXISTS run_of_show_items (
  event_id TEXT NOT NULL,
  wedding_id TEXT NOT NULL,
  sort_order INTEGER NOT NULL,
  time TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY (event_id, sort_order),
  FOREIGN KEY (event_id, wedding_id) REFERENCES events(id, wedding_id) ON DELETE CASCADE
);

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
  dietary_presets TEXT NOT NULL DEFAULT '',
  dietary_consent_at INTEGER,
  dietary_consent_version TEXT,
  consent_source TEXT NOT NULL DEFAULT 'guest',
  created_at INTEGER NOT NULL,
  submitted_by_guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL,
  submitted_via_link INTEGER NOT NULL DEFAULT 0,
  recorded_by_osn_profile_id TEXT,
  dietary_attested_by_osn_profile_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS rsvps_guest_event_uniq ON rsvps(guest_id, event_id);
CREATE INDEX IF NOT EXISTS rsvps_event_id_idx ON rsvps(event_id);
CREATE INDEX IF NOT EXISTS rsvps_submitted_by_idx ON rsvps(submitted_by_guest_id) WHERE submitted_by_guest_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS rsvp_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  guest_id TEXT NOT NULL,
  event_id TEXT,
  kind TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  actor_guest_id TEXT,
  actor_osn_profile_id TEXT
);
CREATE INDEX IF NOT EXISTS rsvp_changes_wedding_actor_idx ON rsvp_changes(wedding_id, actor_osn_profile_id);
CREATE INDEX IF NOT EXISTS rsvp_changes_created_at_idx ON rsvp_changes(created_at);
CREATE INDEX IF NOT EXISTS rsvp_changes_household_created_at_idx ON rsvp_changes(created_at) WHERE actor_osn_profile_id IS NULL;
CREATE INDEX IF NOT EXISTS rsvp_changes_family_idx ON rsvp_changes(family_id);

CREATE TABLE IF NOT EXISTS host_rsvp_notices (
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  osn_profile_id TEXT NOT NULL,
  seen_seq INTEGER NOT NULL DEFAULT 0,
  digest_seq INTEGER NOT NULL DEFAULT 0,
  digest_enabled INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (wedding_id, osn_profile_id)
);

CREATE TABLE IF NOT EXISTS owner_notice_budget (
  key TEXT NOT NULL,
  day TEXT NOT NULL,
  sent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, day)
);

CREATE TABLE IF NOT EXISTS realtime_subscribe_budget (
  osn_profile_id TEXT NOT NULL,
  day TEXT NOT NULL,
  subscribes INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, osn_profile_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  member_guest_id TEXT REFERENCES guests(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS sessions_family_idx ON sessions(family_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS sessions_member_idx ON sessions(member_guest_id) WHERE member_guest_id IS NOT NULL;

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
CREATE INDEX IF NOT EXISTS guest_account_links_wedding_idx ON guest_account_links(wedding_id);

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
  registry_tone TEXT,
  hero_visible INTEGER NOT NULL DEFAULT 1,
  story_visible INTEGER NOT NULL DEFAULT 1,
  footer_visible INTEGER NOT NULL DEFAULT 1,
  faq_visible INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS wedding_faqs (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wedding_faqs_wedding_sort_idx ON wedding_faqs(wedding_id, sort_order, id);

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
  completed_at INTEGER,
  template_id TEXT,
  template_item TEXT,
  due_offset_days INTEGER,
  due_source TEXT NOT NULL DEFAULT 'manual',
  assigned_host_id TEXT REFERENCES wedding_hosts(id) ON DELETE SET NULL,
  run_at TEXT,
  run_timezone TEXT,
  event_id TEXT REFERENCES events(id) ON DELETE SET NULL,
  run_offset_minutes INTEGER,
  event_removed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_wedding_bucket_sort_idx ON tasks(wedding_id, timeframe_bucket, sort_order);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_wedding_template_item_unique ON tasks(wedding_id, template_id, template_item) WHERE template_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS tasks_assigned_host_idx ON tasks(assigned_host_id) WHERE assigned_host_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS tasks_id_wedding_unique ON tasks(id, wedding_id);
CREATE INDEX IF NOT EXISTS tasks_event_idx ON tasks(event_id) WHERE event_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_assignees (
  task_id TEXT NOT NULL,
  host_id TEXT NOT NULL,
  wedding_id TEXT NOT NULL,
  assigned_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, host_id),
  FOREIGN KEY (task_id, wedding_id) REFERENCES tasks(id, wedding_id) ON DELETE CASCADE,
  FOREIGN KEY (host_id, wedding_id) REFERENCES wedding_hosts(id, wedding_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS task_assignees_host_wedding_idx ON task_assignees(host_id, wedding_id);
CREATE INDEX IF NOT EXISTS task_assignees_wedding_task_idx ON task_assignees(wedding_id, task_id, assigned_at);

CREATE TABLE IF NOT EXISTS task_template_dismissals (
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL,
  template_item TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  PRIMARY KEY (wedding_id, template_id, template_item)
);

CREATE TABLE IF NOT EXISTS budget_items (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  estimate_minor INTEGER,
  quoted_minor INTEGER,
  actual_minor INTEGER,
  unit_price_minor INTEGER,
  per_head_event_ids TEXT,
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
  updated_at INTEGER NOT NULL,
  review_org_id TEXT,
  review_profile_id TEXT,
  review_requested_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS directory_vendors_owner_uniq ON directory_vendors(owner_org_id);
CREATE UNIQUE INDEX IF NOT EXISTS directory_vendors_review_org_uniq ON directory_vendors(review_org_id);
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
  updated_at INTEGER NOT NULL,
  handoff_chat_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS vendor_enquiries_wedding_directory_uniq ON vendor_enquiries(wedding_id, directory_vendor_id);
CREATE INDEX IF NOT EXISTS vendor_enquiries_wedding_last_msg_idx ON vendor_enquiries(wedding_id, last_message_at, id);
CREATE INDEX IF NOT EXISTS vendor_enquiries_directory_last_msg_idx ON vendor_enquiries(directory_vendor_id, last_message_at, id);
CREATE INDEX IF NOT EXISTS vendor_enquiries_vendor_idx ON vendor_enquiries(vendor_id);
CREATE INDEX IF NOT EXISTS vendor_enquiries_buffered_idx ON vendor_enquiries(updated_at, id) WHERE status = 'open' AND zap_chat_id IS NULL AND pending_body IS NOT NULL;
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
  stripe_default_currency TEXT,
  stripe_deauthorized_at INTEGER,
  stripe_deauthorized_account_id TEXT,
  gift_summary_json TEXT,
  gift_summary_at INTEGER,
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
CREATE INDEX IF NOT EXISTS registry_items_wedding_image_idx ON registry_items(wedding_id, image_key);
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
  note_hidden_at INTEGER,
  note_hidden_by_osn_profile_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT registry_claims_quantity_ck CHECK (quantity >= 1 and quantity <= 99),
  CONSTRAINT registry_claims_status_ck CHECK (status in ('reserved','purchased','released'))
);
CREATE UNIQUE INDEX IF NOT EXISTS registry_claims_item_family_uniq ON registry_claims(item_id, family_id);
CREATE INDEX IF NOT EXISTS registry_claims_wedding_created_idx ON registry_claims(wedding_id, created_at);
CREATE INDEX IF NOT EXISTS registry_claims_family_idx ON registry_claims(family_id);
CREATE INDEX IF NOT EXISTS registry_claims_item_status_idx ON registry_claims(item_id, status, family_id, quantity);
CREATE INDEX IF NOT EXISTS registry_claims_wedding_item_status_idx ON registry_claims(wedding_id, item_id, status, quantity);
CREATE TABLE IF NOT EXISTS registry_contributions (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  item_id TEXT REFERENCES registry_items(id) ON DELETE SET NULL,
  item_title TEXT,
  family_id TEXT NOT NULL REFERENCES families(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  primary_amount_minor INTEGER,
  primary_currency TEXT,
  fx_rate TEXT,
  fx_rate_at INTEGER,
  refunded_amount_minor INTEGER,
  stripe_checkout_session_id TEXT UNIQUE,
  stripe_payment_intent_id TEXT,
  message TEXT,
  display_name TEXT,
  thanked_at INTEGER,
  thanked_by TEXT,
  note_hidden_at INTEGER,
  note_hidden_by_osn_profile_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS registry_contributions_wedding_created_idx ON registry_contributions(wedding_id, created_at);
CREATE INDEX IF NOT EXISTS registry_contributions_item_idx ON registry_contributions(item_id);
CREATE INDEX IF NOT EXISTS registry_contributions_family_idx ON registry_contributions(family_id);
CREATE INDEX IF NOT EXISTS registry_contributions_payment_intent_idx ON registry_contributions(stripe_payment_intent_id);
CREATE TABLE IF NOT EXISTS wedding_upgrade_purchases (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  entitlement TEXT NOT NULL,
  from_tier TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  checkout_session_id TEXT UNIQUE,
  payment_intent_id TEXT,
  price_id TEXT,
  price_amount_minor INTEGER,
  price_currency TEXT,
  amount_minor INTEGER,
  currency TEXT,
  created_by_osn_profile_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS wedding_upgrade_purchases_wedding_entitlement_idx ON wedding_upgrade_purchases(wedding_id, entitlement);
CREATE INDEX IF NOT EXISTS wedding_upgrade_purchases_payment_intent_idx ON wedding_upgrade_purchases(payment_intent_id);
CREATE UNIQUE INDEX IF NOT EXISTS wedding_upgrade_purchases_one_pending_uniq ON wedding_upgrade_purchases(wedding_id) WHERE status = 'pending';
CREATE TABLE IF NOT EXISTS platform_sales (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE,
  entitlement TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency TEXT NOT NULL,
  settled_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS link_thumb_transforms (
  period TEXT PRIMARY KEY NOT NULL,
  used INTEGER DEFAULT 0 NOT NULL
);
CREATE TABLE IF NOT EXISTS unlock_codes (
  id TEXT PRIMARY KEY NOT NULL,
  code_hash TEXT NOT NULL UNIQUE,
  tier TEXT NOT NULL,
  max_redemptions INTEGER NOT NULL,
  redeemed_count INTEGER DEFAULT 0 NOT NULL,
  expires_at INTEGER,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT unlock_codes_tier_ck CHECK (tier in ('gold','crimson')),
  CONSTRAINT unlock_codes_uses_ck CHECK (max_redemptions >= 1 and redeemed_count >= 0 and redeemed_count <= max_redemptions)
);
CREATE TABLE IF NOT EXISTS unlock_code_redemptions (
  id TEXT PRIMARY KEY NOT NULL,
  code_id TEXT NOT NULL REFERENCES unlock_codes(id) ON DELETE CASCADE,
  wedding_id TEXT NOT NULL REFERENCES weddings(id) ON DELETE CASCADE,
  redeemed_by_osn_profile_id TEXT,
  redeemed_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS unlock_code_redemptions_code_wedding_uniq ON unlock_code_redemptions(code_id, wedding_id);
CREATE INDEX IF NOT EXISTS unlock_code_redemptions_wedding_idx ON unlock_code_redemptions(wedding_id);

CREATE TABLE IF NOT EXISTS seating_tables (
  id TEXT PRIMARY KEY,
  wedding_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL,
  capacity INTEGER NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  FOREIGN KEY (event_id, wedding_id) REFERENCES events(id, wedding_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS seating_tables_event_id_uniq ON seating_tables(event_id, id);
CREATE TABLE IF NOT EXISTS seating_assignments (
  table_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  guest_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (table_id, guest_id),
  FOREIGN KEY (table_id, event_id) REFERENCES seating_tables(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (guest_id, event_id) REFERENCES guest_events(guest_id, event_id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS seating_assignments_event_guest_uniq ON seating_assignments(event_id, guest_id);
`;

export function createDb(path: string = ":memory:") {
  const sqlite = new Database(path);
  // bun:sqlite does not enforce foreign keys by default — without this the
  // REFERENCES clauses above are inert and tests would pass on FK-violating
  // data that D1 (FKs always on) would reject.
  sqlite.exec("PRAGMA foreign_keys = ON;");
  // One transaction: on a file every autocommitted statement writes and syncs
  // its own journal, about a hundred of them; in memory it costs nothing.
  sqlite.transaction(() => sqlite.exec(DDL))();
  return drizzle({ client: sqlite });
}

// The precise sync-only shape createDb() returns — narrower than the
// production Db union (which must also cover D1's async driver). Code that only
// ever sees a createDb() handle (test helpers, the local dev server) should take
// this, not Db, so .all()/.get()/.run() keep their sync return types inside it.
export type TestDb = ReturnType<typeof createDb>;

// Sample wedding for local dev + the test suite — every seeded family/event is
// scoped to it. Owned by the fixed dev id (DEV_OWNER_PROFILE_ID), through an
// `owner` seat with the fixed id DEV_OWNER_SEAT_ID; exported so tests that build
// their own fixtures on a bare createDb() can satisfy the wedding_id FK. This is
// the local/test path only — deployed D1 has no seeded wedding (migration 0015
// removed the orphaned bootstrap row); real OSN users create their own weddings
// via POST /api/organiser/weddings.
export function seedBootstrapWedding(db: Db): void {
  const now = new Date();
  db.insert(schema.weddings)
    .values({
      id: schema.BOOTSTRAP_WEDDING_ID,
      slug: "cire-wedding",
      displayName: "Cire Wedding",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.weddingHosts)
    .values({
      id: DEV_OWNER_SEAT_ID,
      weddingId: schema.BOOTSTRAP_WEDDING_ID,
      osnProfileId: DEV_OWNER_PROFILE_ID,
      addedByOsnProfileId: DEV_OWNER_PROFILE_ID,
      role: "owner",
      createdAt: now,
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

/**
 * Hands the sample wedding's owner seat (id `DEV_OWNER_SEAT_ID`) to
 * `osnProfileId`, so the local dev server lists the sample wedding for a real
 * signed-in account. Afterwards the profile holds that seat as `owner` and no
 * other seat on the sample wedding; its seats on other weddings are untouched.
 *
 * Any other seat the profile holds on the sample wedding is deleted first: a
 * profile holds one seat per wedding (`wedding_hosts_wedding_profile_uniq`), so
 * the update would otherwise fail on the unique index. `seedDb` seeds no co-host
 * seats, so on a fresh seed that delete matches nothing.
 *
 * Takes the synchronous `createDb()` handle because the delete must land before
 * the update. `scripts/cire-db-seed.sh` repoints the D1 seed with the same two
 * statements in SQL; a change to one belongs in the other.
 */
export function repointDevOwnerSeat(db: TestDb, osnProfileId: string): void {
  db.delete(schema.weddingHosts)
    .where(
      and(
        eq(schema.weddingHosts.weddingId, schema.BOOTSTRAP_WEDDING_ID),
        eq(schema.weddingHosts.osnProfileId, osnProfileId),
        ne(schema.weddingHosts.id, DEV_OWNER_SEAT_ID),
      ),
    )
    .run();
  db.update(schema.weddingHosts)
    .set({ osnProfileId, addedByOsnProfileId: osnProfileId, role: "owner" })
    .where(eq(schema.weddingHosts.id, DEV_OWNER_SEAT_ID))
    .run();
}

/**
 * Gives the sample wedding an RSVP deadline: the last moment of `date`
 * (`YYYY-MM-DD`) in UTC. The local dev server calls it when
 * `CIRE_E2E_RSVP_DEADLINE` is set; the E2E suite sets one far in the future,
 * so this server keeps taking replies on the suite clock while a flow moves
 * the browser's clock past the deadline.
 *
 * `seedDb` sets no deadline, so every test on the real clock sees RSVPs open.
 * A date that is not a real calendar day throws instead of being stored: it
 * would read back as no deadline at all.
 */
export function setSampleRsvpDeadline(db: TestDb, date: string): void {
  if (resolveRsvpDeadline(date, DEFAULT_RSVP_DEADLINE_TIMEZONE, new Date()) === null) {
    throw new Error(`RSVP deadline is not a YYYY-MM-DD calendar date: "${date}"`);
  }
  db.update(schema.weddings)
    .set({ rsvpDeadline: date, rsvpDeadlineTimezone: DEFAULT_RSVP_DEADLINE_TIMEZONE })
    .where(eq(schema.weddings.id, schema.BOOTSTRAP_WEDDING_ID))
    .run();
}

/**
 * The local dev server's reading of `CIRE_E2E_RSVP_DEADLINE`: set, it gives the
 * sample wedding that deadline (`setSampleRsvpDeadline`); unset or empty, the
 * seed's open RSVPs stand, which is what every `bun run dev` without the E2E
 * suite gets.
 */
export function applyE2eRsvpDeadline(
  db: TestDb,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const date = env.CIRE_E2E_RSVP_DEADLINE;
  if (date) setSampleRsvpDeadline(db, date);
}

/**
 * A second wedding for the E2E suite's gift-list flows: on Gold, with a
 * published list of three gifts and one cash fund, one household of one
 * invited to one event, and the wedding's host preview household. The values
 * the flows check are written out again in
 * `tools/e2e/src/config.ts` (`CIRE_GIFT_LIST`); a change here goes there too,
 * and the claimed flow fails until it does.
 *
 * The couple are taking money as far as their own settings go: money gifts
 * on, a connected account that can charge and settles in the wedding's
 * currency. The stack runs cire-api with no Stripe key, so no gift can be paid
 * for there, and the guest list must offer neither the money form nor the
 * fund. That is the deployment check the claimed flow holds.
 *
 * Its own wedding rather than the sample one, so the gift band that a
 * published list puts on the invite never appears in the other cire flows.
 * No `image_key` on any gift: the local asset store starts empty.
 */
export function seedE2eGiftList(db: TestDb): void {
  const now = new Date();
  const weddingId = "wed_e2e_gift_list";
  const eventId = "evt_e2e_gift_reception";
  const familyId = "fam_e2e_gift_list";
  const guestId = "gst_e2e_gift_list";

  db.insert(schema.weddings)
    .values({
      id: weddingId,
      slug: "gift-wedding",
      displayName: "Gift Wedding",
      tier: "gold",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.events)
    .values({
      id: eventId,
      weddingId,
      slug: "reception",
      name: "Reception",
      startAt: "2099-06-20T16:00:00+00:00",
      endAt: "2099-06-20T22:00:00+00:00",
      timezone: "UTC",
    })
    .run();
  db.insert(schema.families)
    .values({
      id: familyId,
      weddingId,
      publicId: "TESTGFT-FIG-EE55",
      familyName: "Giftfamily",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.guests)
    .values({
      id: guestId,
      familyId,
      firstName: "Gil",
      lastName: "Giftfamily",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.guestEvents).values({ guestId, eventId }).run();

  // The wedding's host preview household, as `hostCodeService.ensureForWedding`
  // makes it for "Preview invite", with a fixed code so a flow can open the
  // preview link without the organiser portal.
  db.insert(schema.families)
    .values({
      id: "fam_e2e_gift_host",
      weddingId,
      publicId: "HOST-E2E00000000000000000000000000001",
      familyName: "Host Preview",
      kind: "host",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.guests)
    .values({
      id: "gst_e2e_gift_host",
      familyId: "fam_e2e_gift_host",
      firstName: "Wedding",
      lastName: "Host",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.guestEvents).values({ guestId: "gst_e2e_gift_host", eventId }).run();

  db.insert(schema.registrySettings)
    .values({
      weddingId,
      published: true,
      headline: "Our gift list",
      message: "Your being there is the gift. This list is here if you would like it.",
      cashGiftsEnabled: true,
      stripeAccountId: "acct_e2e_gift_list",
      stripeChargesEnabled: true,
      stripePayoutsEnabled: true,
      stripeDefaultCurrency: "AUD",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(schema.registryItems)
    .values([
      {
        id: "reg_e2e_gift_0001",
        weddingId,
        title: "Copper saucepan",
        priceMinor: 32_000,
        category: "Kitchen",
        sortOrder: 0,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "reg_e2e_gift_0002",
        weddingId,
        title: "Stoneware mixing bowls",
        priceMinor: 14_500,
        quantityWanted: 2,
        category: "Kitchen",
        sortOrder: 1,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "reg_e2e_gift_0003",
        weddingId,
        title: "A walk on the beach together",
        priceMinor: null,
        category: null,
        sortOrder: 2,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "reg_e2e_gift_fund",
        weddingId,
        kind: "cash_fund",
        title: "Honeymoon in Kyoto",
        description: "Trains, temples and a very good dinner.",
        targetMinor: 500_000,
        sortOrder: 3,
        createdAt: now,
        updatedAt: now,
      },
    ])
    .run();
}

/**
 * The local dev server's reading of `CIRE_E2E_REGISTRY`: `"1"` adds the
 * gift-list wedding (`seedE2eGiftList`); anything else, unset included, leaves
 * the seed as it is, which is what every `bun run dev` without the E2E suite
 * gets.
 */
export function applyE2eGiftList(
  db: TestDb,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env.CIRE_E2E_REGISTRY === "1") seedE2eGiftList(db);
}

/** An owner seat for the dev profile on one of the E2E organiser weddings. */
function seatDevOwner(db: TestDb, weddingId: string, seatId: string, now: Date): void {
  db.insert(schema.weddingHosts)
    .values({
      id: seatId,
      weddingId,
      osnProfileId: DEV_OWNER_PROFILE_ID,
      addedByOsnProfileId: DEV_OWNER_PROFILE_ID,
      role: "owner",
      createdAt: now,
    })
    .run();
}

/**
 * Five weddings for the E2E suite's organiser flows, each on Gold. The dev
 * profile, which osn-api's `/dev/login` signs in as, owns the first four and is
 * a helper on the fifth:
 *
 * - `wed_e2e_checklist`: a wedding date (2099-06-20) and an empty checklist,
 *   for the starter checklist.
 * - `wed_e2e_holders`: one open task nobody holds, an editor and a viewer, for
 *   putting people on a task and removing one from the wedding.
 * - `wed_e2e_scope`: a helper seeing their own tasks, for widening, narrowing
 *   and resetting what a helper sees on the run sheet.
 * - `wed_e2e_runsheet`: the day of 2026-10-01 in Sydney — the suite's clock
 *   starts at 10:00 there — with three events, two of them carrying a run of
 *   show, and tasks linked to each, one twenty minutes away; for reading the
 *   run sheet as an owner and moving and removing its events.
 * - `wed_e2e_rs_helper`: the same day, where the dev profile is a helper who
 *   sees their own tasks, and a co-host holds a task of another event; for
 *   reading what such a helper is given.
 *
 * The co-hosts are bare profile ids with no OSN account behind them; the local
 * server resolves no names, so the portal shows the ids. Every id and value a
 * flow checks is written out again as `CIRE_ORGANISER` in
 * `tools/e2e/src/config.ts`; a change here goes there too.
 */
export function seedE2eOrganiser(db: TestDb): void {
  const now = new Date();
  const wedding = (id: string, slug: string, displayName: string, weddingDate?: string) =>
    db
      .insert(schema.weddings)
      .values({
        id,
        slug,
        displayName,
        tier: "gold",
        weddingDate: weddingDate ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();

  wedding("wed_e2e_checklist", "checklist-wedding", "Checklist Wedding", "2099-06-20");
  seatDevOwner(db, "wed_e2e_checklist", "whost_e2e_checklist_owner", now);

  wedding("wed_e2e_holders", "holders-wedding", "Holders Wedding");
  seatDevOwner(db, "wed_e2e_holders", "whost_e2e_holders_owner", now);
  db.insert(schema.weddingHosts)
    .values([
      {
        id: "whost_e2e_bea",
        weddingId: "wed_e2e_holders",
        osnProfileId: "usr_e2e_bea",
        addedByOsnProfileId: DEV_OWNER_PROFILE_ID,
        role: "editor",
        createdAt: now,
      },
      {
        id: "whost_e2e_cal",
        weddingId: "wed_e2e_holders",
        osnProfileId: "usr_e2e_cal",
        addedByOsnProfileId: DEV_OWNER_PROFILE_ID,
        role: "viewer",
        createdAt: now,
      },
    ])
    .run();
  db.insert(schema.tasks)
    .values({
      id: "tsk_e2e_holders_venue",
      weddingId: "wed_e2e_holders",
      title: "Book the venue",
      timeframeBucket: "12m",
      status: "open",
      sortOrder: 0,
      createdAt: now,
    })
    .run();

  wedding("wed_e2e_scope", "scope-wedding", "Scope Wedding");
  seatDevOwner(db, "wed_e2e_scope", "whost_e2e_scope_owner", now);
  db.insert(schema.weddingHosts)
    .values({
      id: "whost_e2e_dee",
      weddingId: "wed_e2e_scope",
      osnProfileId: "usr_e2e_dee",
      addedByOsnProfileId: DEV_OWNER_PROFILE_ID,
      role: "helper",
      runSheetScope: "own",
      createdAt: now,
    })
    .run();

  const event = (
    id: string,
    weddingId: string,
    name: string,
    startAt: string,
    endAt: string,
    sortOrder: number,
    place: { venueName?: string; address?: string } = {},
  ): typeof schema.events.$inferInsert => ({
    id,
    weddingId,
    slug: id.replace(/_/g, "-"),
    name,
    startAt,
    endAt,
    timezone: "Australia/Sydney",
    venueName: place.venueName ?? null,
    address: place.address ?? null,
    sortOrder,
  });
  const runOfShow = (eventId: string, weddingId: string, items: [string, string][]) =>
    items.map(([time, label], sortOrder) => ({ eventId, weddingId, sortOrder, time, label }));
  const task = (
    id: string,
    weddingId: string,
    title: string,
    timeframeBucket: string,
    link: { eventId: string; runOffsetMinutes: number } | null,
    sortOrder: number,
  ): typeof schema.tasks.$inferInsert => ({
    id,
    weddingId,
    title,
    timeframeBucket,
    status: "open",
    sortOrder,
    createdAt: now,
    eventId: link?.eventId ?? null,
    runOffsetMinutes: link?.runOffsetMinutes ?? null,
  });
  const hold = (taskId: string, hostId: string, weddingId: string) => ({
    taskId,
    hostId,
    weddingId,
    assignedAt: now,
  });

  wedding("wed_e2e_runsheet", "run-sheet-wedding", "Run Sheet Wedding");
  seatDevOwner(db, "wed_e2e_runsheet", "whost_e2e_runsheet_owner", now);
  db.insert(schema.weddingHosts)
    .values({
      id: "whost_e2e_fay",
      weddingId: "wed_e2e_runsheet",
      osnProfileId: "usr_e2e_fay",
      addedByOsnProfileId: DEV_OWNER_PROFILE_ID,
      role: "helper",
      runSheetScope: "own",
      createdAt: now,
    })
    .run();
  db.insert(schema.events)
    .values([
      event(
        "evt_e2e_rs_ceremony",
        "wed_e2e_runsheet",
        "Ceremony",
        "2026-10-01T11:00:00+10:00",
        "2026-10-01T12:00:00+10:00",
        0,
        { venueName: "The Chapel", address: "1 Chapel Lane, Exampleville NSW 2001" },
      ),
      event(
        "evt_e2e_rs_reception",
        "wed_e2e_runsheet",
        "Reception",
        "2026-10-01T18:00:00+10:00",
        "2026-10-01T23:00:00+10:00",
        1,
      ),
      event("evt_e2e_rs_brunch", "wed_e2e_runsheet", "Brunch", "2026-10-02T10:00:00+10:00", "", 2),
    ])
    .run();
  db.insert(schema.runOfShowItems)
    .values([
      ...runOfShow("evt_e2e_rs_ceremony", "wed_e2e_runsheet", [
        ["11:00", "Processional"],
        ["11:40", "Signing the register"],
      ]),
      // Stored in the organiser's order, not the clock's: the run sheet reads
      // it from the start, an item earlier than the start after midnight.
      ...runOfShow("evt_e2e_rs_reception", "wed_e2e_runsheet", [
        ["18:30", "Entrée"],
        ["00:15", "Last dance"],
        ["17:30", "Doors close"],
      ]),
    ])
    .run();
  db.insert(schema.tasks)
    .values([
      task(
        "tsk_e2e_rs_greet",
        "wed_e2e_runsheet",
        "Greet the celebrant",
        "day_of",
        { eventId: "evt_e2e_rs_ceremony", runOffsetMinutes: -40 },
        0,
      ),
      task(
        "tsk_e2e_rs_cake",
        "wed_e2e_runsheet",
        "Set up the cake table",
        "week_of",
        { eventId: "evt_e2e_rs_reception", runOffsetMinutes: -60 },
        0,
      ),
      task(
        "tsk_e2e_rs_hamper",
        "wed_e2e_runsheet",
        "Pack the hamper",
        "day_of",
        { eventId: "evt_e2e_rs_brunch", runOffsetMinutes: -30 },
        1,
      ),
      task("tsk_e2e_rs_rings", "wed_e2e_runsheet", "Bring the rings", "day_of", null, 2),
      task("tsk_e2e_rs_cards", "wed_e2e_runsheet", "Order thank-you cards", "1m", null, 0),
    ])
    .run();
  db.insert(schema.taskAssignees)
    .values([
      hold("tsk_e2e_rs_greet", "whost_e2e_runsheet_owner", "wed_e2e_runsheet"),
      hold("tsk_e2e_rs_cake", "whost_e2e_fay", "wed_e2e_runsheet"),
      hold("tsk_e2e_rs_rings", "whost_e2e_runsheet_owner", "wed_e2e_runsheet"),
    ])
    .run();

  wedding("wed_e2e_rs_helper", "helper-wedding", "Helper Wedding");
  db.insert(schema.weddingHosts)
    .values([
      {
        id: "whost_e2e_gus",
        weddingId: "wed_e2e_rs_helper",
        osnProfileId: "usr_e2e_gus",
        addedByOsnProfileId: "usr_e2e_gus",
        role: "owner",
        createdAt: now,
      },
      {
        id: "whost_e2e_rs_helper_me",
        weddingId: "wed_e2e_rs_helper",
        osnProfileId: DEV_OWNER_PROFILE_ID,
        addedByOsnProfileId: "usr_e2e_gus",
        role: "helper",
        runSheetScope: "own",
        createdAt: now,
      },
    ])
    .run();
  db.insert(schema.events)
    .values([
      event(
        "evt_e2e_rsh_arrival",
        "wed_e2e_rs_helper",
        "Guest arrival",
        "2026-10-01T14:30:00+10:00",
        "",
        0,
        { venueName: "The Barn", address: "9 Barn Road, Exampleville NSW 2001" },
      ),
      event(
        "evt_e2e_rsh_speeches",
        "wed_e2e_rs_helper",
        "Speeches",
        "2026-10-01T16:00:00+10:00",
        "",
        1,
      ),
    ])
    .run();
  db.insert(schema.runOfShowItems)
    .values([
      ...runOfShow("evt_e2e_rsh_arrival", "wed_e2e_rs_helper", [["14:45", "Welcome drinks"]]),
      ...runOfShow("evt_e2e_rsh_speeches", "wed_e2e_rs_helper", [["16:10", "Best man"]]),
    ])
    .run();
  db.insert(schema.tasks)
    .values([
      task(
        "tsk_e2e_rsh_programmes",
        "wed_e2e_rs_helper",
        "Hand out programmes",
        "day_of",
        { eventId: "evt_e2e_rsh_arrival", runOffsetMinutes: -30 },
        0,
      ),
      task(
        "tsk_e2e_rsh_cue",
        "wed_e2e_rs_helper",
        "Cue the speeches",
        "day_of",
        { eventId: "evt_e2e_rsh_speeches", runOffsetMinutes: -10 },
        1,
      ),
    ])
    .run();
  db.insert(schema.taskAssignees)
    .values([
      hold("tsk_e2e_rsh_programmes", "whost_e2e_rs_helper_me", "wed_e2e_rs_helper"),
      hold("tsk_e2e_rsh_cue", "whost_e2e_gus", "wed_e2e_rs_helper"),
    ])
    .run();
}

/**
 * The local dev server's reading of `CIRE_E2E_ORGANISER`: `"1"` adds the
 * organiser weddings (`seedE2eOrganiser`); anything else, unset included,
 * leaves the seed as it is, which is what every `bun run dev` without the E2E
 * suite gets.
 */
export function applyE2eOrganiser(
  db: TestDb,
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (env.CIRE_E2E_ORGANISER === "1") seedE2eOrganiser(db);
}
