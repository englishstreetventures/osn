import { sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

/**
 * Every table whose rows belong to a wedding, reached from `weddings.id` by
 * `ON DELETE cascade` foreign keys, directly or through a parent. A purge of
 * the wedding must leave none of its rows in any of them.
 */
export const WEDDING_CHILD_TABLES = [
  "wedding_hosts",
  "families",
  "guests",
  "events",
  "guest_events",
  "rsvps",
  "rsvp_changes",
  "host_rsvp_notices",
  "sessions",
  "guest_account_links",
  "wedding_invite_customisations",
  "wedding_faqs",
  "imports",
  "tasks",
  "budget_items",
  "payments",
  "vendors",
  "vendor_enquiries",
  "wedding_entitlements",
  "registry_settings",
  "registry_items",
  "registry_claims",
  "registry_contributions",
  "wedding_upgrade_purchases",
  "unlock_code_redemptions",
] as const;

/** The household's claim code {@link fullWeddingStatements} writes. Upper
 *  case, as the claim route normalises what a guest types. */
export const fullWeddingCode = (id: string): string => `CODE-${id.toUpperCase()}`;

/** The R2 keys {@link fullWeddingStatements} writes, by bucket. */
export function fullWeddingKeys(id: string): { sheets: string[]; assets: string[] } {
  return {
    sheets: [
      `imports/imp_${id}/events.csv`,
      `imports/imp_${id}/guests.csv`,
      `imports/imp_${id}/before/events.csv`,
      `imports/imp_${id}/before/guests.csv`,
    ],
    assets: [
      `assets/${id}/hero-1`,
      `assets/${id}/story-1`,
      `assets/${id}/footer-1`,
      `assets/${id}/event-1`,
      `assets/${id}/registry-1`,
    ],
  };
}

/**
 * Insert statements for a wedding with one row in every one of
 * {@link WEDDING_CHILD_TABLES}, an R2 key in every key column, a settled
 * upgrade's `platform_sales` row (which has no foreign key), the unlock code
 * its redemption spent (outside the cascade, like the sale), and the shared
 * directory listing its enquiry names. Statements, not writes, so the same
 * fixture serves bun:sqlite (`db.run` returns at once) and D1 (`await
 * db.run`). `deletedAt` soft-deletes it; `owner` is the deleting owner.
 */
export function fullWeddingStatements(
  id: string,
  opts: { deletedAt?: Date | null; owner?: string; now?: Date } = {},
): SQL[] {
  const now = opts.now ?? new Date();
  const s = Math.floor(now.getTime() / 1000);
  const owner = opts.owner ?? `usr_owner_${id}`;
  const deletedAt =
    opts.deletedAt === undefined || opts.deletedAt === null
      ? null
      : Math.floor(opts.deletedAt.getTime() / 1000);
  const deletedBy = deletedAt === null ? null : owner;
  const keys = fullWeddingKeys(id);
  const fam = `fam_${id}`;
  const guest = `gst_${id}`;
  const event = `evt_${id}`;
  const item = `ritem_${id}`;
  const budget = `bud_${id}`;
  const dirVendor = `dv_${id}`;
  const vendor = `ven_${id}`;
  const purchase = `upg_${id}`;
  return [
    sql`INSERT INTO weddings (id, slug, display_name, tier, created_at, updated_at, deleted_at, deleted_by_osn_profile_id) VALUES (${id}, ${`slug-${id}`}, ${`Wedding ${id}`}, 'crimson', ${s}, ${s}, ${deletedAt}, ${deletedBy})`,
    sql`INSERT INTO wedding_hosts (id, wedding_id, osn_profile_id, added_by_osn_profile_id, role, created_at) VALUES (${`whost_${id}`}, ${id}, ${owner}, ${owner}, 'owner', ${s})`,
    sql`INSERT INTO families (id, wedding_id, public_id, family_name, created_at, updated_at) VALUES (${fam}, ${id}, ${fullWeddingCode(id)}, 'Family', ${s}, ${s})`,
    sql`INSERT INTO guests (id, family_id, first_name, created_at, updated_at) VALUES (${guest}, ${fam}, 'Ada', ${s}, ${s})`,
    sql`INSERT INTO events (id, wedding_id, slug, name, start_at, end_at, timezone, event_image_key) VALUES (${event}, ${id}, 'ceremony', 'Ceremony', '2027-01-01T10:00', '2027-01-01T11:00', 'UTC', ${keys.assets[3]!})`,
    sql`INSERT INTO guest_events (guest_id, event_id) VALUES (${guest}, ${event})`,
    sql`INSERT INTO rsvps (id, guest_id, event_id, status, created_at) VALUES (${`rsvp_${id}`}, ${guest}, ${event}, 'attending', ${s})`,
    sql`INSERT INTO rsvp_changes (wedding_id, family_id, guest_id, kind, created_at) VALUES (${id}, ${fam}, ${guest}, 'attending', ${s})`,
    sql`INSERT INTO host_rsvp_notices (wedding_id, osn_profile_id, updated_at) VALUES (${id}, ${owner}, ${s})`,
    sql`INSERT INTO sessions (id, family_id, token, expires_at, created_at) VALUES (${`ses_${id}`}, ${fam}, ${`tok_${id}`}, ${s + 86_400}, ${s})`,
    sql`INSERT INTO guest_account_links (id, guest_id, family_id, wedding_id, osn_account_id, osn_profile_id, linked_at, updated_at) VALUES (${`gal_${id}`}, ${guest}, ${fam}, ${id}, 'acc_1', 'usr_guest', ${s}, ${s})`,
    sql`INSERT INTO wedding_invite_customisations (wedding_id, updated_at, hero_image_key, story_image_key, footer_image_key) VALUES (${id}, ${s}, ${keys.assets[0]!}, ${keys.assets[1]!}, ${keys.assets[2]!})`,
    sql`INSERT INTO wedding_faqs (id, wedding_id, question, answer, created_at, updated_at) VALUES (${`faq_${id}`}, ${id}, 'Q', 'A', ${s}, ${s})`,
    sql`INSERT INTO imports (id, wedding_id, uploaded_at, format, events_r2_key, guests_r2_key, before_events_r2_key, before_guests_r2_key, summary, status) VALUES (${`imp_${id}`}, ${id}, ${s}, 'csv', ${keys.sheets[0]!}, ${keys.sheets[1]!}, ${keys.sheets[2]!}, ${keys.sheets[3]!}, '{}', 'applied')`,
    sql`INSERT INTO tasks (id, wedding_id, title, timeframe_bucket, created_at) VALUES (${`task_${id}`}, ${id}, 'Book', '12m', ${s})`,
    sql`INSERT INTO budget_items (id, wedding_id, category, name, created_at, updated_at) VALUES (${budget}, ${id}, 'venue', 'Hall', ${s}, ${s})`,
    sql`INSERT INTO payments (id, budget_item_id, label, amount_minor, created_at) VALUES (${`pay_${id}`}, ${budget}, 'Deposit', 100, ${s})`,
    sql`INSERT INTO directory_vendors (id, name, created_at, updated_at) VALUES (${dirVendor}, 'Listing', ${s}, ${s})`,
    sql`INSERT INTO vendors (id, wedding_id, name, category, created_at, updated_at) VALUES (${vendor}, ${id}, 'Florist', 'florist', ${s}, ${s})`,
    sql`INSERT INTO vendor_enquiries (id, wedding_id, directory_vendor_id, vendor_id, created_by, last_message_at, created_at, updated_at) VALUES (${`enq_${id}`}, ${id}, ${dirVendor}, ${vendor}, ${owner}, ${s}, ${s}, ${s})`,
    sql`INSERT INTO wedding_entitlements (wedding_id, entitlement, source, granted_at, granted_by) VALUES (${id}, 'registry', 'comp', ${s}, ${owner})`,
    sql`INSERT INTO registry_settings (wedding_id, created_at, updated_at, published) VALUES (${id}, ${s}, ${s}, 1)`,
    sql`INSERT INTO registry_items (id, wedding_id, title, image_key, created_at, updated_at) VALUES (${item}, ${id}, 'Vase', ${keys.assets[4]!}, ${s}, ${s})`,
    sql`INSERT INTO registry_claims (id, wedding_id, item_id, family_id, created_at, updated_at) VALUES (${`rclm_${id}`}, ${id}, ${item}, ${fam}, ${s}, ${s})`,
    sql`INSERT INTO registry_contributions (id, wedding_id, family_id, status, amount_minor, currency, created_at, updated_at) VALUES (${`rcon_${id}`}, ${id}, ${fam}, 'succeeded', 5000, 'AUD', ${s - 30 * 86_400}, ${s})`,
    sql`INSERT INTO wedding_upgrade_purchases (id, wedding_id, entitlement, status, created_by_osn_profile_id, created_at, updated_at) VALUES (${purchase}, ${id}, 'vendors', 'succeeded', ${owner}, ${s - 30 * 86_400}, ${s})`,
    sql`INSERT INTO platform_sales (id, purchase_id, entitlement, amount_minor, currency, settled_at) VALUES (${`sale_${id}`}, ${purchase}, 'vendors', 4900, 'AUD', ${s})`,
    sql`INSERT INTO unlock_codes (id, code_hash, tier, max_redemptions, redeemed_count, created_by, created_at) VALUES (${`ulc_${id}`}, ${`hash_${id}`}, 'crimson', 1, 1, 'script:ops', ${s})`,
    sql`INSERT INTO unlock_code_redemptions (id, code_id, wedding_id, redeemed_by_osn_profile_id, redeemed_at) VALUES (${`ulr_${id}`}, ${`ulc_${id}`}, ${id}, ${owner}, ${s})`,
  ];
}
