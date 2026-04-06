import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";
import { events } from "./events";

export const eventRsvps = sqliteTable(
  "event_rsvps",
  {
    id: text("id").primaryKey(), // "rsvp_" prefix
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    userId: text("user_id").notNull(), // references osn-db users (cross-DB, no FK)
    status: text("status", { enum: ["going", "interested", "not_going"] })
      .notNull()
      .default("going"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    unique("event_rsvps_pair_idx").on(t.eventId, t.userId),
    index("event_rsvps_event_idx").on(t.eventId),
    index("event_rsvps_user_idx").on(t.userId),
  ],
);

export type EventRsvp = typeof eventRsvps.$inferSelect;
export type NewEventRsvp = typeof eventRsvps.$inferInsert;
