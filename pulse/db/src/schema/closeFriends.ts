import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";

/**
 * Pulse-scoped close friends.
 *
 * One-way edge owned by Pulse — independent of the OSN-core social graph.
 * Each OSN app can implement its own list (or skip the concept entirely);
 * Pulse uses this list as a personal signal:
 *
 *   1. Feed boost: events whose organiser is a close friend of the viewer
 *      surface higher in `listEvents`.
 *   2. Hosting affordance: when inviting guests, close friends are surfaced
 *      first; the green-ring avatar treatment on RSVP rows ("attendee X
 *      considers the viewer a close friend") is also driven by this table.
 *
 * `friendId` references a profile owned by `@osn/api` — there is no FK
 * here because the two databases are separate (cross-DB references are
 * validated at the service layer via the `graphBridge.getConnectionIds`
 * eligibility check).
 */
export const pulseCloseFriends = sqliteTable(
  "pulse_close_friends",
  {
    id: text("id").primaryKey(), // "pcf_" prefix
    profileId: text("profile_id").notNull(),
    friendId: text("friend_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    unique("pulse_close_friends_pair_idx").on(t.profileId, t.friendId),
    index("pulse_close_friends_profile_idx").on(t.profileId),
    index("pulse_close_friends_friend_idx").on(t.friendId),
  ],
);

export type PulseCloseFriend = typeof pulseCloseFriends.$inferSelect;
export type NewPulseCloseFriend = typeof pulseCloseFriends.$inferInsert;
