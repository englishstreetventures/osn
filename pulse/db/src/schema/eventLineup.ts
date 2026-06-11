import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

import { events } from "./events";

/**
 * A programmed slot in an event's lineup — "DJ X plays from 22:00 to 23:30".
 *
 * One row per (event, slot). The same artist appearing twice on a night
 * gets two rows. Multi-artist back-to-back sets are a single row whose
 * `artistName` reads "Artist A b2b Artist B" — kept as a single string
 * because that is how lineups are billed and posted; if we ever need to
 * link individual artists to profiles we'll add a join table rather
 * than restructuring this one.
 *
 * `slotStart` may be earlier than `slotEnd` even when the slot crosses
 * midnight — both are absolute timestamps, not times-of-day, so a 23:30
 * → 01:00 set has slotEnd > slotStart and orders correctly.
 */
export const eventLineup = sqliteTable(
  "event_lineup",
  {
    id: text("id").primaryKey(), // "lnp_" prefix
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    /** Display name of the artist or back-to-back pairing. */
    artistName: text("artist_name").notNull(),
    /**
     * Bounded role enum so the timeline can style headliners differently
     * without parsing free text. Add new roles as the platform grows.
     */
    role: text("role", {
      enum: ["headliner", "support", "resident", "opener", "guest"],
    })
      .notNull()
      .default("support"),
    slotStart: integer("slot_start", { mode: "timestamp" }).notNull(),
    slotEnd: integer("slot_end", { mode: "timestamp" }).notNull(),
    /**
     * Render order within the night. Mostly redundant with `slotStart`,
     * but kept so two simultaneous stages can be ordered deterministically
     * later (single-stage venues only need one stage's worth of slots
     * for now, so all rows on an event share an event_id ordering domain).
     */
    orderIndex: integer("order_index").notNull().default(0),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    // Powers `GET /events/:id/lineup` — walk a single event's slots in time order.
    index("event_lineup_event_id_idx").on(t.eventId, t.slotStart),
  ],
);

export type EventLineupSlot = typeof eventLineup.$inferSelect;
export type NewEventLineupSlot = typeof eventLineup.$inferInsert;
