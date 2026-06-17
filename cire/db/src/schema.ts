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
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("weddings_owner_idx").on(t.ownerOsnProfileId)],
);

export const families = sqliteTable(
  "families",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
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
    sortOrder: integer("sort_order").notNull().default(0),
    // Forward-looking: spreadsheet "Guest ID" column. Currently nullable —
    // matching is `(family, firstName)` until the source sheet adds a stable
    // ID column (see PR-C). Surfacing this now means re-imports won't churn
    // data when that column lands.
    externalId: text("external_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("guests_family_id_sort_idx").on(t.familyId, t.sortOrder)],
);

// `id` is a UUID v4 string. `slug` and `location` are kept for backwards
// compatibility with migration 0001 — `address` is the canonical free-form
// venue address going forward; `location` will be retired in a later PR.
// `date` is similarly deprecated in favour of `startAt` / `endAt` /
// `timezone`. Forward-only D1 migrations preclude column drops here.
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    date: text("date").notNull(),
    location: text("location").notNull(),
    description: text("description").notNull().default(""),
    startAt: text("start_at").notNull(),
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
  },
  (t) => [
    index("events_sort_order_idx").on(t.sortOrder),
    index("events_wedding_idx").on(t.weddingId),
  ],
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
  heroImageKey: text("hero_image_key"),
  storyImageKey: text("story_image_key"),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
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
