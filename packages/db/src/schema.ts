import {
  sqliteTable,
  text,
  integer,
  primaryKey,
  index,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const families = sqliteTable(
  "families",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull().unique(),
    familyName: text("family_name").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("families_family_name_idx").on(t.familyName)],
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
  (t) => [index("events_sort_order_idx").on(t.sortOrder)],
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

// Tracks every spreadsheet upload through the organiser portal so we can
// preview, apply, and (later) revert a batch import. See [[wiki/TODO.md]] →
// "Organiser Spreadsheet Import" for the surrounding flow.
export const imports = sqliteTable(
  "imports",
  {
    id: text("id").primaryKey(),
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
  (t) => [index("imports_status_uploaded_at_idx").on(t.status, t.uploadedAt)],
);
