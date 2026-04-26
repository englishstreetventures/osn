import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";

import { events } from "./events";

export const eventRsvps = sqliteTable(
  "event_rsvps",
  {
    id: text("id").primaryKey(), // "rsvp_" prefix
    eventId: text("event_id")
      .notNull()
      .references(() => events.id),
    profileId: text("profile_id").notNull(), // references osn-db users (cross-DB, no FK)
    // "invited" is the pre-RSVP state for events with joinPolicy = "guest_list".
    // Organisers invite users (status = "invited") and those users can then
    // transition to "going" / "interested" / "not_going".
    // "interested" is rendered as "Maybe" in the UI.
    status: text("status", { enum: ["going", "interested", "not_going", "invited"] })
      .notNull()
      .default("going"),
    // Optional: who added the "invited" row (organiser). NULL on self-RSVPs.
    invitedByProfileId: text("invited_by_profile_id"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    unique("event_rsvps_pair_idx").on(t.eventId, t.profileId),
    index("event_rsvps_event_idx").on(t.eventId),
    index("event_rsvps_profile_idx").on(t.profileId),
    // P-W3: powers the visibility-filter EXISTS lookup, which keys on the
    // constant `viewerId` first then the per-row `event_id`. The
    // `event_rsvps_pair_idx` above has the wrong leading column for this
    // shape (it's `(event_id, profile_id)`).
    index("event_rsvps_profile_event_idx").on(t.profileId, t.eventId),
  ],
);

export type EventRsvp = typeof eventRsvps.$inferSelect;
export type NewEventRsvp = typeof eventRsvps.$inferInsert;
