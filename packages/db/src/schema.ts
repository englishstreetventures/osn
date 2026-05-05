import { sqliteTable, text, integer, primaryKey, index } from "drizzle-orm/sqlite-core";

export const families = sqliteTable(
  "families",
  {
    id: text("id").primaryKey(),
    publicId: text("public_id").notNull().unique(),
    familyName: text("family_name").notNull(),
    passwordHash: text("password_hash").notNull(),
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
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("guests_family_id_idx").on(t.familyId)],
);

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  date: text("date").notNull(),
  location: text("location").notNull(),
  description: text("description").notNull().default(""),
});

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

export const rsvps = sqliteTable("rsvps", {
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
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  familyId: text("family_id")
    .notNull()
    .references(() => families.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
});
