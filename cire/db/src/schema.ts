import { sql } from "drizzle-orm";
import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Tenant id of the original bespoke wedding (seeded by migration 0006 and
// by the test seed). Interim single-tenant scope hardcoded at write sites
// until Phase 5 threads the authenticated wedding through the API.
export const BOOTSTRAP_WEDDING_ID = "wed_bootstrap";

// Multi-tenant root. Owner is an OSN profile id (`usr_*`) — an opaque
// string, deliberately NOT a foreign key: cire's D1 and osn's D1 are
// separate databases. Ownership is verified at the API layer against a
// signature-checked OSN access token. Single-owner today; a
// wedding_owners join table (role: owner/editor/viewer) is the planned
// multi-owner upgrade.
export const weddings = sqliteTable(
  "weddings",
  {
    id: text("id").primaryKey(), // wed_<ulid>; bootstrap row is "wed_bootstrap"
    slug: text("slug").notNull().unique(),
    displayName: text("display_name").notNull(),
    ownerOsnProfileId: text("owner_osn_profile_id").notNull(),
    // Claim-code tier driving family `public_id` generation (C1). `secure`
    // (default) = 10-char Crockford hash (~60-bit total code); `simple` =
    // 6-char hash (~40-bit). Read by the tiered generator in
    // `cire/api/src/services/family-code.ts` at mint time. NOT NULL with a
    // DEFAULT so historical rows + new D1 inserts that omit it land on `secure`.
    codeStyle: text("code_style", { enum: ["simple", "secure"] })
      .notNull()
      .default("secure"),
    // ── Wedding profile (platform Phase 0, migration 0030) ──────────────────
    // Organiser-provided planning facts. Everything is nullable — engaged
    // couples often have none of this yet — and NOTHING here is guest-facing:
    // the profile drives the planning modules (pricing estimates, checklist
    // lead-time seeding), never the invite render.
    //
    // Deliberately NO location columns here: a wedding is not a place — its
    // EVENTS are (a Sydney reception + Jaipur ceremonies is one wedding in two
    // countries), and each event's place is its free-text `address` (the sole
    // location source; see the events table). Money stays wedding-scoped: one
    // MAIN currency the organiser thinks in, whatever countries the events land in.
    //
    // `wedding_date` is a date-only ISO string (`YYYY-MM-DD`, no time/zone —
    // the day is the planning fact; per-event timing stays on `events`).
    weddingDate: text("wedding_date"),
    guestCountEstimate: integer("guest_count_estimate"),
    // ISO 4217 code for every money figure on this wedding (budget, payments).
    // NOT NULL with a DEFAULT so historical rows + inserts that omit it land
    // on AUD.
    currency: text("currency").notNull().default("AUD"),
    // Total budget in MINOR units (cents) of `currency` — integers only, no
    // float money.
    budgetTotalMinor: integer("budget_total_minor"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("weddings_owner_idx").on(t.ownerOsnProfileId)],
);

// Co-hosts of a wedding. The creator stays the single `weddings.owner_osn_profile_id`
// (it answers "who may manage hosts + do destructive things"); this join table
// adds *additional* organisers who can reach the wedding's dashboard. The owner
// is NOT rowed in here — owner-OR-host is resolved in the authz gate — so the
// owner can't be removed as a "host" and "who is the owner" stays unambiguous.
//
// `osn_profile_id` is an OSN profile id (`usr_*`), like `weddings.owner_osn_profile_id`:
// an opaque cross-database reference, deliberately NOT a foreign key (cire's D1
// and osn's D1 are separate databases). It's resolved from a typed handle via a
// server-to-server ARC call to osn-api's `/graph/internal/profile-by-handle`
// (cire never sees the handle→id mapping otherwise). `added_by_osn_profile_id`
// records which owner added the host (audit only). `role` splits co-hosts into
// `editor` (full module writes — a partner or hired planner) and `viewer`
// (read-only). `host` is LEGACY: migration 0031 rewrote every 'host' row to
// 'editor' and the app only ever writes editor/viewer, but the value stays in
// the enum because the column's DDL DEFAULT 'host' can't change without a
// table rebuild — readers normalise a stray 'host' to 'editor'.
export const weddingHosts = sqliteTable(
  "wedding_hosts",
  {
    id: text("id").primaryKey(), // whost_<uuid>
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    osnProfileId: text("osn_profile_id").notNull(),
    addedByOsnProfileId: text("added_by_osn_profile_id").notNull(),
    role: text("role", { enum: ["host", "editor", "viewer"] })
      .notNull()
      .default("host"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // One host row per (wedding, profile) — adding the same person twice is a
    // no-op conflict the service swallows, never a duplicate seat.
    uniqueIndex("wedding_hosts_wedding_profile_uniq").on(t.weddingId, t.osnProfileId),
    // Reverse lookup: "which weddings does this profile co-host?" — backs the
    // portal's combined owned-OR-hosted wedding list.
    index("wedding_hosts_profile_idx").on(t.osnProfileId),
    // List all hosts of a wedding (the management panel) in one b-tree scan.
    index("wedding_hosts_wedding_idx").on(t.weddingId),
  ],
);

export const families = sqliteTable(
  "families",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    // The household's claim code (`SURNAME-WORD-HASH`). REQUIRED + globally
    // unique — EVERY household carries a code (product-owner decision 2026-07-15;
    // migration 0033 reversed PR 4's code-less households: 0032 made this nullable
    // with a partial unique index, 0033 rebuilt `families` back to NOT NULL + a
    // full column-level UNIQUE and dropped the partial index). There is no
    // code-less path: CSV import auto-mints a code per family, and the organiser
    // editor mints one when it creates a household.
    publicId: text("public_id").notNull().unique(),
    familyName: text("family_name").notNull(),
    // Distinguishes a real invited household ("guest") from the synthetic
    // per-wedding "host" preview family. A wedding has at most one host family:
    // its claim code (a `HOST-*` public_id) lets the organiser open the guest
    // invite and see every event. Host families are excluded from the
    // spreadsheet-import diff (a CSV re-import must never remove them) and are
    // barred from submitting RSVPs (preview-only, see `cire/api` rsvp route).
    kind: text("kind", { enum: ["guest", "host"] })
      .notNull()
      .default("guest"),
    // When the organiser last copied this family's invite message (the
    // per-family "Copy message" button). NULL = never shared. Drives the
    // remint "already sent out" warning: reminting rotates the code and
    // invalidates any already-shared link, so the bulk remint clears this back
    // to NULL for every rotated family. Best-effort: set by `mark-shared`, not
    // a security boundary, so a missed write only under-counts the warning.
    codeSharedAt: integer("code_shared_at", { mode: "timestamp" }),
    // When a guest FIRST opened this family's invite with its CURRENT code (the
    // guest claim path — `cire/api` claimService.lookup). NULL = never opened.
    // Recorded ONCE on first contact and never overwritten, so it reflects the
    // first real claim — a reliable "Opened" signal for the organiser dashboard,
    // unlike `codeSharedAt` (which only means the organiser copied the message).
    // Host-preview claims (`kind === "host"`, the organiser's own preview) are
    // excluded so opening the preview never counts. Cleared back to NULL on
    // remint, since the rotated code has never been opened.
    firstOpenedAt: integer("first_opened_at", { mode: "timestamp" }),
    // When the organiser DEACTIVATED this family's claim code (migration 0024).
    // NULL = active (the default, so existing rows self-backfill as active). A
    // non-null timestamp cuts the family off: the guest claim path
    // (`cire/api` claimService.lookup) rejects a deactivated family's code with
    // the SAME generic invalid-credentials failure an unknown code gets, so a
    // withdrawn invite stops working without revealing the code ever existed.
    // Reversible — reactivating sets it back to NULL. The family/guests/RSVPs
    // are untouched, so the data survives and a re-activated code works again.
    // Host-preview families (`kind === "host"`) are never deactivated by this.
    deactivatedAt: integer("deactivated_at", { mode: "timestamp" }),
    // Provenance (guest+event editor E4, migration 0035). `'import'` = created
    // by a spreadsheet upload; `'manual'` = created by the in-app editor
    // (E5/E6). DEFAULT 'import' back-fills legacy rows (all import-created). A
    // CSV re-import manages only `source = 'import'` households by default (a
    // sheet must not silently delete a hand-added household); an explicit
    // "remove manual too" toggle widens it, and an editor save manages
    // everything it was shown regardless of source (see the import diff).
    source: text("source", { enum: ["import", "manual"] })
      .notNull()
      .default("import"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("families_family_name_idx").on(t.familyName),
    index("families_wedding_idx").on(t.weddingId),
    // At most one host family per wedding. A partial unique index makes the
    // host-code find-or-create race-safe at the DB layer.
    uniqueIndex("families_one_host_per_wedding")
      .on(t.weddingId)
      .where(sql`kind = 'host'`),
  ],
);

export const guests = sqliteTable(
  "guests",
  {
    id: text("id").primaryKey(),
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull().default(""),
    // Optional informal name for the personalised single-guest greeting
    // ("Dear {nickname}"). NULL ⇒ fall back to `firstName`. Only used to greet a
    // one-guest code as an individual; family greetings stay surname-based.
    nickname: text("nickname"),
    sortOrder: integer("sort_order").notNull().default(0),
    // Forward-looking: spreadsheet "Guest ID" column. Currently nullable —
    // matching is `(family, firstName)` until the source sheet adds a stable
    // ID column (see PR-C). Surfacing this now means re-imports won't churn
    // data when that column lands.
    externalId: text("external_id"),
    // Provenance (guest+event editor E4, migration 0035). Mirrors
    // `families.source`: `'import'` (spreadsheet-created) | `'manual'`
    // (editor-created, E5/E6), DEFAULT 'import' back-fills legacy rows. A CSV
    // re-import removes only `source = 'import'` guests by default; the editor
    // manages all shown guests. See the import diff's provenance filter.
    source: text("source", { enum: ["import", "manual"] })
      .notNull()
      .default("import"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("guests_family_id_sort_idx").on(t.familyId, t.sortOrder)],
);

// `id` is a UUID v4 string. The canonical timing is `startAt` / `endAt` /
// `timezone`; the canonical venue is the free-form `address`. (The legacy
// `date` + `location` columns these superseded were dropped in migration 0025.)
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    startAt: text("start_at").notNull(),
    // "" = no stated end (End is optional in the events sheet). Kept NOT NULL
    // with the empty-string sentinel so no table rebuild was needed; consumers
    // (invite display, calendar links, retention sweep) treat "" as end-less
    // and fall back to startAt where an instant is required.
    endAt: text("end_at").notNull(),
    timezone: text("timezone").notNull(),
    address: text("address"),
    dressCodeDescription: text("dress_code_description"),
    // JSON-encoded `Array<{name: string, color: string}>` — decoded by the
    // claim service before serialising the response.
    dressCodePalette: text("dress_code_palette"),
    pinterestUrl: text("pinterest_url"),
    mapsUrl: text("maps_url"),
    sortOrder: integer("sort_order").notNull().default(0),
    // Optional R2 object key for this event's ONE image (migration 0019). NULL ⇒
    // the event renders text-only at every breakpoint (no empty image half).
    // Stores the **key** (not a URL), exactly like
    // `wedding_invite_customisations.hero_image_key` — bytes live in the
    // `cire-assets` bucket and are served through the API. The key carries a
    // fresh uuid per upload, so the served image's cache version derives from it
    // server-side (a re-upload mints a new key ⇒ a new version, never stale).
    eventImageKey: text("event_image_key"),
    // JSON-encoded normalised crop rectangle `{x,y,w,h}` in SOURCE FRACTIONS
    // (0..1) the organiser chose for this event's image (migration 0021). NULL ⇒
    // the default centre `object-cover` crop, so an un-cropped image renders
    // exactly as before. One rectangle captures both pan and zoom (a zoom is just
    // a smaller `{w,h}` box panned by `{x,y}`). Validated server-side on write
    // (`cire/api/src/schemas/invite.ts`) and applied in CSS on the guest site, so
    // the stored bytes are untouched.
    eventImageCrop: text("event_image_crop"),
    // No location config: the free-text `address` above is the SOLE location
    // source (the only thing the guest map embed renders). The stored
    // coordinates + pricing_region a wedding could carry (migration 0030) were
    // dropped by 0036 — they only fed unbuilt Phase 3 planning features
    // (vendor-radius search, per-region pricing), never the invite. If Phase 3
    // ever needs a point it geocodes `address` on-demand then (YAGNI).
  },
  // Composite index covering the (wedding filter, sort) access pattern used by
  // every events read (migration 0026). Replaces the dead single-column
  // events_sort_order_idx + events_wedding_idx pair — mirrors
  // guests_family_id_sort_idx above.
  (t) => [index("events_wedding_id_sort_idx").on(t.weddingId, t.sortOrder)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    notes: text("notes"),
    timeframeBucket: text("timeframe_bucket").notNull(),
    // Optional ISO date (YYYY-MM-DD), independent of the bucket.
    dueAt: text("due_at"),
    status: text("status").notNull().default("open"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    completedAt: integer("completed_at", { mode: "timestamp" }),
  },
  (t) => [index("tasks_wedding_bucket_sort_idx").on(t.weddingId, t.timeframeBucket, t.sortOrder)],
);

export const budgetItems = sqliteTable(
  "budget_items",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    // Service category (shared enum, cire/api/src/lib/service-categories.ts).
    category: text("category").notNull(),
    name: text("name").notNull(),
    // Three OPTIONAL money figures, minor units of the wedding's currency.
    estimateMinor: integer("estimate_minor"),
    quotedMinor: integer("quoted_minor"),
    actualMinor: integer("actual_minor"),
    notes: text("notes"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("budget_items_wedding_category_sort_idx").on(t.weddingId, t.category, t.sortOrder)],
);

export const payments = sqliteTable(
  "payments",
  {
    id: text("id").primaryKey(),
    budgetItemId: text("budget_item_id")
      .notNull()
      .references(() => budgetItems.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    amountMinor: integer("amount_minor").notNull(),
    // Optional ISO date (YYYY-MM-DD) the payment is due.
    dueAt: text("due_at"),
    // Set when marked paid; null while outstanding.
    paidAt: integer("paid_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("payments_item_idx").on(t.budgetItemId)],
);

// Vendors Slice 1 (platform Phase 2, migration 0040).
// directory_vendors: the global business listing (one per OSN org).
export const directoryVendors = sqliteTable(
  "directory_vendors",
  {
    id: text("id").primaryKey(),
    ownerOrgId: text("owner_org_id"),
    name: text("name").notNull(),
    description: text("description"),
    email: text("email"),
    phone: text("phone"),
    website: text("website"),
    instagram: text("instagram"),
    locationText: text("location_text"),
    priceBand: text("price_band"),
    priceMinMinor: integer("price_min_minor"),
    priceMaxMinor: integer("price_max_minor"),
    listed: text("listed").notNull().default("draft"),
    // The vendor's own CRM lead-capture address; cire also notifies it on a new
    // enquiry (a separate copy, not a BCC — keeps the address off the vendor
    // thread email). Null until the vendor sets it in the portal.
    leadForwardEmail: text("lead_forward_email"),
    // The OSN profile that claimed this listing (recorded at consumeClaim time).
    // Becomes the vendor-side member of any c2b enquiry chat. Null until claimed.
    claimedByProfileId: text("claimed_by_profile_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("directory_vendors_owner_idx").on(t.ownerOrgId),
    index("directory_vendors_listed_idx").on(t.listed),
  ],
);

// directory_vendor_categories: many service categories per listing.
export const directoryVendorCategories = sqliteTable(
  "directory_vendor_categories",
  {
    directoryVendorId: text("directory_vendor_id")
      .notNull()
      .references(() => directoryVendors.id, { onDelete: "cascade" }),
    category: text("category").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.directoryVendorId, t.category] }),
    index("directory_vendor_categories_category_idx").on(t.category),
  ],
);

// vendors: the wedding-scoped CRM row (organiser-private).
export const vendors = sqliteTable(
  "vendors",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    directoryVendorId: text("directory_vendor_id"),
    name: text("name").notNull(),
    category: text("category").notNull(),
    status: text("status").notNull().default("researching"),
    contactName: text("contact_name"),
    email: text("email"),
    phone: text("phone"),
    notes: text("notes"),
    quotedMinor: integer("quoted_minor"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("vendors_wedding_status_idx").on(t.weddingId, t.status, t.sortOrder),
    uniqueIndex("vendors_wedding_directory_uniq")
      .on(t.weddingId, t.directoryVendorId)
      .where(sql`directory_vendor_id IS NOT NULL`),
  ],
);

export const vendorEnquiries = sqliteTable(
  "vendor_enquiries",
  {
    id: text("id").primaryKey(), // enq_<uuid>
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    // The directory listing enquired. No FK cascade: a listing outliving a
    // wedding is fine; the wedding cascade above is the lifecycle owner.
    directoryVendorId: text("directory_vendor_id").notNull(),
    // The couple's CRM row (created-if-missing on open) — ties status/quote back
    // into the S1 Vendors module.
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id, { onDelete: "cascade" }),
    // The provisioned Zap c2b chat. Null until provisioned (unclaimed listing:
    // provisioning is deferred to claim time; the first message waits in
    // `pendingBody`).
    zapChatId: text("zap_chat_id"),
    // Buffered first message for an enquiry whose chat isn't provisioned yet.
    // Flushed into Zap + nulled when the vendor claims. Exactly one of
    // (zapChatId set) / (pendingBody set) holds for an open enquiry.
    pendingBody: text("pending_body"),
    status: text("status", { enum: ["open", "quoted", "closed"] })
      .notNull()
      .default("open"),
    createdBy: text("created_by").notNull(), // osn profile id of the organiser
    quotedMinor: integer("quoted_minor"), // latest quote; mirrors vendors.quoted_minor
    lastMessageAt: integer("last_message_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // One thread per (wedding, listing) — the idempotency key for open.
    uniqueIndex("vendor_enquiries_wedding_directory_uniq").on(t.weddingId, t.directoryVendorId),
    // Couple inbox: newest-first per wedding.
    index("vendor_enquiries_wedding_last_msg_idx").on(t.weddingId, t.lastMessageAt),
    // Vendor inbox: find a listing's enquiries.
    index("vendor_enquiries_directory_idx").on(t.directoryVendorId),
  ],
);

// vendor_claims: email-verification claim tokens (SHA-256 hashed, single-use, TTL).
export const vendorClaims = sqliteTable(
  "vendor_claims",
  {
    id: text("id").primaryKey(),
    directoryVendorId: text("directory_vendor_id")
      .notNull()
      .references(() => directoryVendors.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    email: text("email").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    consumedAt: integer("consumed_at", { mode: "timestamp" }),
  },
  (t) => [index("vendor_claims_vendor_idx").on(t.directoryVendorId)],
);

// wedding_entitlements: per-wedding unlocked packs (platform tiering, migration
// 0042). Row-presence = entitled. The whole paid model is a SET here: a wedding
// holds any subset of packs. Boolean packs (`premium_templates`, `vendors`,
// `ai`) gate features by presence; capacity is LEVELED — the effective guest
// ceiling is DERIVED from the highest capacity_* row (none→100, capacity_500→500,
// capacity_1000→1000), so there is deliberately no guest_cap column to drift.
// `source` distinguishes a provider purchase from a comp/manual grant (V&R,
// "contact us" capacity, support goodwill). `provider_ref` carries the
// external provider reference on purchases (NULL on comp) and is the
// Phase-2 webhook idempotency key.
export const weddingEntitlements = sqliteTable(
  "wedding_entitlements",
  {
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    entitlement: text("entitlement", {
      enum: ["premium_templates", "vendors", "ai", "capacity_500", "capacity_1000"],
    }).notNull(),
    source: text("source", { enum: ["purchase", "comp"] }).notNull(),
    grantedAt: integer("granted_at", { mode: "timestamp" }).notNull(),
    grantedBy: text("granted_by").notNull(),
    providerRef: text("provider_ref"),
  },
  (t) => [primaryKey({ columns: [t.weddingId, t.entitlement] })],
);

export const guestEvents = sqliteTable(
  "guest_events",
  {
    guestId: text("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
  },
  (t) => [
    primaryKey({ columns: [t.guestId, t.eventId] }),
    index("guest_events_event_id_idx").on(t.eventId),
  ],
);

export const rsvps = sqliteTable(
  "rsvps",
  {
    id: text("id").primaryKey(),
    guestId: text("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    status: text("status", {
      enum: ["attending", "declined", "maybe"],
    }).notNull(),
    dietary: text("dietary").notNull().default(""),
    // Explicit Art. 9(2)(a) consent record for the special-category `dietary`
    // free-text (see [[wiki/compliance/dpia/cire-guest-data]] → C-H2). Captured
    // here, 1:1 with the RSVP, because consent authorises exactly this row's
    // dietary data and the `(guest_id, event_id)` upsert already keys it — a
    // separate table would duplicate that key and add a join for no gain. Both
    // columns are null unless the guest ticked the opt-in for non-empty dietary
    // text; `dietary_consent_at` is when they consented, `dietary_consent_version`
    // pins which privacy-notice/copy version they agreed to.
    dietaryConsentAt: integer("dietary_consent_at", { mode: "timestamp" }),
    dietaryConsentVersion: text("dietary_consent_version"),
    // WHO recorded this reply AND on whose consent authority the dietary
    // free-text is held (migration 0037; see [[wiki/compliance/dpia/cire-guest-data]]
    // → C-H2 organiser-attested variant). `'guest'` — the guest RSVP'd
    // themselves and gave their own Art. 9(2)(a) consent. `'organiser_attested'`
    // — an organiser recorded a phone/paper RSVP on the guest's behalf and
    // *attests* the guest consented to storing dietary requirements. One column
    // carries both facts because the writer and the consent-attester are always
    // the same principal here, so a separate `recorded_by` would be 1:1
    // redundant. Legacy rows back-fill to `'guest'` (the form was the only
    // writer pre-0037). The dashboard reads this to badge organiser-entered
    // answers distinctly and show they overwrite a prior guest reply.
    consentSource: text("consent_source", {
      enum: ["guest", "organiser_attested"],
    })
      .notNull()
      .default("guest"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [uniqueIndex("rsvps_guest_event_uniq").on(t.guestId, t.eventId)],
);

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  familyId: text("family_id")
    .notNull()
    .references(() => families.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

// Optional link between an individual invitee (a `guests` row) and a real
// OSN/Pulse account. Opt-in and additive: the family claim-code session stays
// the primary guest credential; this row just attaches an OSN identity so the
// invitee can surface the invitation inside Pulse and (with their household)
// see other family members' RSVPs.
//
// `osn_account_id` is the OSN *account* principal (resolved server-to-server
// over ARC from the access token's profile id — see
// `[[wiki/systems/cire-auth]]`). Account-level (not profile-level) so any of a
// user's OSN profiles can see the invitation. Like `weddings.owner_osn_profile_id`
// it is an opaque cross-database reference, deliberately NOT a foreign key:
// cire's D1 and osn's D1 are separate databases. `osn_profile_id` records which
// profile performed the link (audit only).
export const guestAccountLinks = sqliteTable(
  "guest_account_links",
  {
    id: text("id").primaryKey(), // gal_<uuid>
    guestId: text("guest_id")
      .notNull()
      .references(() => guests.id, { onDelete: "cascade" }),
    // Denormalised household + tenant scope so reverse lookups ("which families
    // has this account linked", organiser audit) stay single-table. Both cascade
    // with their parents; the FK on guest_id already covers row lifetime.
    familyId: text("family_id")
      .notNull()
      .references(() => families.id, { onDelete: "cascade" }),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    osnAccountId: text("osn_account_id").notNull(),
    osnProfileId: text("osn_profile_id").notNull(),
    linkedAt: integer("linked_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    // One link per invitee.
    uniqueIndex("guest_account_links_guest_uniq").on(t.guestId),
    // An OSN account can't claim two seats in the same household. Spanning
    // different families/weddings IS allowed (one person, many invitations).
    uniqueIndex("guest_account_links_family_account_uniq").on(t.familyId, t.osnAccountId),
    // Reverse lookup: account → all linked invitees (Pulse feed integration).
    index("guest_account_links_account_idx").on(t.osnAccountId),
    // List all links for a household (guest-facing status endpoint).
    index("guest_account_links_family_idx").on(t.familyId),
  ],
);

// Per-wedding presentation overrides for the guest invite ("invite builder").
// Strictly additive + presentational: the event/guest source of truth stays in
// the CSV-imported `events`/`families`/`guests` tables — this row only lets an
// organiser swap a few images and rewrite a few copy blocks on top of the
// existing animated invite. One row per wedding (PK = weddingId enforces 1:1);
// a missing row (or a null column) means "use the built-in default", so the
// invite renders unchanged until an organiser customises it.
//
// Image columns store **R2 object keys** (not URLs) — bytes live in the
// `cire-assets` bucket and are served through the API, mirroring how `imports`
// stores `eventsR2Key`/`guestsR2Key`. The fixed slot set (hero, story) is a
// closed union in `cire/api/src/schemas/invite.ts`.
export const weddingInviteCustomisations = sqliteTable("wedding_invite_customisations", {
  weddingId: text("wedding_id")
    .primaryKey()
    .references(() => weddings.id, { onDelete: "cascade" }),
  heroTitle: text("hero_title"),
  heroSubtitle: text("hero_subtitle"),
  storyEyebrow: text("story_eyebrow"),
  storyHeading: text("story_heading"),
  storyBody: text("story_body"),
  // Events ("details") section header copy (migration 0028) — the eyebrow +
  // heading above the guest's event cards, previously hardcoded to
  // "Celebrate With Us" / "Your Events" while the hero/story copy was editable.
  detailsEyebrow: text("details_eyebrow"),
  detailsHeading: text("details_heading"),
  // Post-claim welcome greeting (migration 0028) — the line under the family /
  // guest name, previously hardcoded to "We are delighted to invite you to
  // celebrate with us." NULL ⇒ the built-in default copy.
  welcomeMessage: text("welcome_message"),
  heroImageKey: text("hero_image_key"),
  storyImageKey: text("story_image_key"),
  // JSON-encoded normalised crop rectangle `{x,y,w,h}` in SOURCE FRACTIONS (0..1)
  // the organiser chose for the hero / story image (migration 0021). NULL ⇒ the
  // default centre `object-cover` crop, so an un-cropped image renders exactly as
  // before. One rectangle captures both pan and zoom. Validated server-side on
  // write (`cire/api/src/schemas/invite.ts`) and applied in CSS on the guest
  // site (the stored bytes are untouched). Saving a crop bumps `updatedAt` so the
  // no-store invite JSON the guest reads carries the new rectangle immediately.
  heroImageCrop: text("hero_image_crop"),
  storyImageCrop: text("story_image_crop"),
  // Phone-specific hero crop (migration 0046). The hero renders full-bleed at
  // wildly different viewport aspects, so it gets a SECOND rectangle (same JSON
  // shape) that the guest site applies below its desktop breakpoint. NULL ⇒
  // narrow viewports fall back to `hero_image_crop` (today's behaviour).
  // Hero-only: the story/event images render at one aspect.
  heroImageCropMobile: text("hero_image_crop_mobile"),
  // Fine-grained hero display sliders (organiser choice; migration 0018 replaced
  // the coarse 0017 enums). All three default to the values that reproduce
  // TODAY's look, so an un-customised wedding renders exactly as before, and the
  // server clamps each to its range in `cire/api/src/schemas/invite.ts` before it
  // is persisted.
  //   `hero_blur` (0–40) — the server-side Gaussian blur radius applied to the
  //     hero backdrop. 28 (default) = the soft `hero-bg` look; 0 = the sharp
  //     full-bleed photo. This is the per-wedding override of the former fixed
  //     `VARIANT_BLUR["hero-bg"]` constant, so changing it must bust the served
  //     image cache (the save bumps `updatedAt`, which keys the transform cache).
  //   `hero_title_backdrop_opacity` (0–100) — opacity (÷100) of the dark
  //     legibility panel behind the hero title text. 0 (default) = no panel.
  //   `hero_title_backdrop_blur` (0–20) — frosted-glass `backdrop-filter` blur in
  //     px behind the title. 0 (default) = no frost.
  heroBlur: integer("hero_blur").notNull().default(28),
  heroTitleBackdropOpacity: integer("hero_title_backdrop_opacity").notNull().default(0),
  heroTitleBackdropBlur: integer("hero_title_backdrop_blur").notNull().default(0),
  // Global typography. A closed enum validated in
  // `cire/api/src/schemas/invite.ts` (never a free-text font URL — that's a perf
  // + CSS-injection risk on the static guest site). NULL ⇒ the built-in token.
  themeHeadingFont: text("theme_heading_font"),
  themeBodyFont: text("theme_body_font"),
  // The invite COLOUR SCHEME (migration 0044) — five seeds, named by their role
  // on the invite, from which every other colour is derived by `derivePalette`
  // in `@cire/theme`. This replaced the eight per-section accent/surface columns
  // from 0014 + 0027: eight free colours asked the organiser to hand-build
  // cohesion, and still only reached five of the guest site's design tokens.
  //
  // Each seed is validated against the same strict CSS-colour allow-list the
  // dress-code palette uses before it can reach an inline `style`. All nullable
  // ⇒ fall back to that role's value in the `evergreen` preset (today's look),
  // so an un-themed invite renders exactly as it always has.
  //
  // `palette_preset` records WHICH curated scheme the organiser started from, so
  // the builder can show it selected and offer a clean reset. It is a bounded
  // key (`PALETTE_PRESETS`), never free text, and is presentation only — the
  // five seed columns are the source of truth for what renders.
  palettePreset: text("palette_preset"),
  paletteGround: text("palette_ground"),
  paletteCard: text("palette_card"),
  paletteInk: text("palette_ink"),
  paletteGilt: text("palette_gilt"),
  paletteBloom: text("palette_bloom"),
  // Per-section TONE — which derived surface a section sits on
  // (`ground` | `card` | `raised`; NULL ⇒ `ground`). This is what carries
  // section identity now that colour is global: alternating surfaces down the
  // page is what made sections read as distinct, not eight free colours.
  heroTone: text("hero_tone"),
  storyTone: text("story_tone"),
  detailsTone: text("details_tone"),
  welcomeTone: text("welcome_tone"),
  // Optional host override for the FIRST line of the message an organiser copies
  // to send a family their invite (migration 0023). NULL ⇒ the built-in default
  // prose. The copied message is always the same 3-line shape — this line, then
  // the guest-site URL, then the family code — so an override only swaps the
  // prose, never the link or code. It is COPIED TO A CLIPBOARD as plain text
  // (never rendered as HTML), so no escaping is needed; the API only trims it,
  // collapses empty/whitespace to NULL, and bounds its length on write.
  inviteMessage: text("invite_message"),
  // Which design pack the invite renders as (invite design selector, 0045).
  // Always a concrete id; unknown values fall back to 'classic' on read.
  designId: text("design_id").notNull().default("classic"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  // The guest IMAGE cache version (migration 0029) — bumped ONLY by image
  // upload/remove/crop and a hero-blur change, never by copy/theme-colour
  // saves, so those stay image-cache-neutral (WT-P-I1). NULL (a row that has
  // only ever seen copy saves) coalesces to `updated_at` at read time.
  imagesUpdatedAt: integer("images_updated_at", { mode: "timestamp" }),
});

// Tracks every spreadsheet upload through the organiser portal so we can
// preview, apply, and (later) revert a batch import. See [[wiki/TODO.md]] →
// "Organiser Spreadsheet Import" for the surrounding flow.
export const imports = sqliteTable(
  "imports",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    uploadedAt: integer("uploaded_at").notNull(),
    format: text("format", { enum: ["csv", "tsv"] }).notNull(),
    eventsR2Key: text("events_r2_key").notNull(),
    guestsR2Key: text("guests_r2_key").notNull(),
    // JSON: counts of families/guests/events + change diff summary.
    summary: text("summary").notNull(),
    status: text("status", {
      enum: ["preview", "applied", "reverted"],
    }).notNull(),
    appliedAt: integer("applied_at"),
    revertedAt: integer("reverted_at"),
    // Change-history kind (guest+event editor E3, [[guest-event-editor]] §4).
    // `'import'` = a spreadsheet upload (the only writer today); `'editor'` = an
    // in-app editor save (E5/E6). DEFAULT 'import' back-fills legacy rows.
    kind: text("kind", { enum: ["import", "editor"] })
      .notNull()
      .default("import"),
    // Before-image snapshot keys (E3): the R2 keys of the wedding's current-state
    // CSVs captured at apply time, BEFORE this change mutated anything. NULLABLE
    // — legacy rows predate the before-image, so revert falls back to the old
    // "re-apply the previous import's sheets" heuristic for them.
    beforeEventsR2Key: text("before_events_r2_key"),
    beforeGuestsR2Key: text("before_guests_r2_key"),
  },
  (t) => [
    // P-W1: import-list pagination is `WHERE wedding_id = ? [AND uploaded_at <
    // cursor] ORDER BY uploaded_at DESC`. This composite covers the scope +
    // cursor/order in one b-tree (and also serves revert.ts's
    // `wedding_id = ? AND status = 'applied' ORDER BY uploaded_at DESC` with
    // status as a residual filter). The old single-column wedding index and the
    // `(status, uploaded_at)` index are dropped: nothing filters by status
    // alone, so the latter served no remaining query.
    index("imports_wedding_uploaded_at_idx").on(t.weddingId, t.uploadedAt),
  ],
);
