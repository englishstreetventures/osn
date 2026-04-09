import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { events } from "./events";

/**
 * Append-only log of communication blasts sent (or queued) for an event.
 *
 * Rows are created by the comms service when the organiser sends a blast.
 * Actual sending is stubbed today — `sentAt` is filled immediately with the
 * timestamp the row was created and no external SMS/email is dispatched.
 * When real providers land, the stub becomes a queue write and `sentAt`
 * becomes null until the provider confirms delivery.
 */
export const eventComms = sqliteTable(
  "event_comms",
  {
    id: text("id").primaryKey(), // "evtcomm_" prefix
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    channel: text("channel", { enum: ["sms", "email"] }).notNull(),
    body: text("body").notNull(),
    // Who triggered the blast (organiser). References osn-db users cross-DB.
    sentByUserId: text("sent_by_user_id").notNull(),
    // Null while queued; filled once the provider stub records dispatch.
    sentAt: integer("sent_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("event_comms_event_idx").on(t.eventId)],
);

export type EventComm = typeof eventComms.$inferSelect;
export type NewEventComm = typeof eventComms.$inferInsert;
