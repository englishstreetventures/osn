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
// records which owner added the host (audit only). `role` is a forward-looking
// column — only `host` exists today, but the column pins the shape for a future
// editor/viewer split without another migration.
export const weddingHosts = sqliteTable(
  "wedding_hosts",
  {
    id: text("id").primaryKey(), // whost_<uuid>
    weddingId: text("wedding_id")
      .notNull()
      .references(() => weddings.id, { onDelete: "cascade" }),
    osnProfileId: text("osn_profile_id").notNull(),
    addedByOsnProfileId: text("added_by_osn_profile_id").notNull(),
    role: text("role", { enum: ["host"] })
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
  // Per-section presentation theme. All columns are nullable ⇒ "use the built-in
  // default token". Fonts are a closed enum validated in
  // `cire/api/src/schemas/invite.ts` (never a free-text font URL — that's a perf
  // + CSS-injection risk on the static guest site); colours are validated against
  // the same strict allow-list the dress-code palette uses before they reach an
  // inline `style`. Two global font choices (heading + body) plus an accent +
  // surface colour per named section (hero / story / details) — a bounded theme,
  // not a generic CSS engine.
  themeHeadingFont: text("theme_heading_font"),
  themeBodyFont: text("theme_body_font"),
  heroAccentColor: text("hero_accent_color"),
  heroSurfaceColor: text("hero_surface_color"),
  storyAccentColor: text("story_accent_color"),
  storySurfaceColor: text("story_surface_color"),
  detailsAccentColor: text("details_accent_color"),
  detailsSurfaceColor: text("details_surface_color"),
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
