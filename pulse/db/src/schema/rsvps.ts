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
    // transition to "going" / "maybe" / "not_going".
    status: text("status", { enum: ["going", "maybe", "not_going", "invited"] })
      .notNull()
      .default("going"),
    // Optional: who added the "invited" row (organiser). NULL on self-RSVPs.
    invitedByProfileId: text("invited_by_profile_id"),
    // Share-attribution columns.
    //
    // `share_source_first` is sticky: it captures the platform (instagram,
    // facebook, tiktok, x, whatsapp, copy_link, other) the attendee first
    // arrived from. Once set, it is never overwritten — analogous to
    // first-touch UTM attribution.
    //
    // `share_source_last` updates every time the user re-enters the event
    // through a sourced link, regardless of prior value. This gives
    // organisers a "most-recent touch" view alongside discovery.
    //
    // The closed enum is validated at the service layer (see
    // `pulse/api/src/lib/shareSource.ts`); the column itself is plain text
    // so widening the union later is a service-only change.
    shareSourceFirst: text("share_source_first"),
    shareSourceFirstSeenAt: integer("share_source_first_seen_at", { mode: "timestamp" }),
    shareSourceLast: text("share_source_last"),
    shareSourceLastSeenAt: integer("share_source_last_seen_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    unique("event_rsvps_pair_idx").on(t.eventId, t.profileId),
    // P-I1 (prep-pr review): no single-column `event_id` index — both the
    // unique pair index above and the (event_id, status) composite below
    // lead on event_id, so it would be pure write amplification.
    index("event_rsvps_profile_idx").on(t.profileId),
    // P-W3: powers the visibility-filter EXISTS lookup, which keys on the
    // constant `viewerId` first then the per-row `event_id`. The
    // `event_rsvps_pair_idx` above has the wrong leading column for this
    // shape (it's `(event_id, profile_id)`).
    index("event_rsvps_profile_event_idx").on(t.profileId, t.eventId),
    // P-I2: status-filtered RSVP reads (`listRsvps?status=…`, the counts
    // GROUP BY) key on `event_id` then filter on `status`. Without the
    // composite, the status filter is a post-index scan over every row
    // the event has.
    index("event_rsvps_event_status_idx").on(t.eventId, t.status),
  ],
);

export type EventRsvp = typeof eventRsvps.$inferSelect;
export type NewEventRsvp = typeof eventRsvps.$inferInsert;
