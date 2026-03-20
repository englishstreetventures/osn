import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"

export const guests = sqliteTable("guests", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  claimCode: text("claim_code").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
})

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  date: text("date").notNull(),
  location: text("location").notNull(),
  description: text("description").notNull().default(""),
})

// Which guests are invited to which events (set by organiser, not RSVP)
export const guestEvents = sqliteTable(
  "guest_events",
  {
    guestId: text("guest_id")
      .notNull()
      .references(() => guests.id),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
  },
  (t) => [primaryKey({ columns: [t.guestId, t.eventId] })],
)

export const rsvps = sqliteTable("rsvps", {
  id: text("id").primaryKey(),
  guestId: text("guest_id")
    .notNull()
    .references(() => guests.id),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id),
  status: text("status", {
    enum: ["attending", "declined", "maybe"],
  }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
})

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  guestId: text("guest_id")
    .notNull()
    .references(() => guests.id),
  token: text("token").notNull().unique(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
})
