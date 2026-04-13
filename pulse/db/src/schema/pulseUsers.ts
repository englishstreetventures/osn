import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

/**
 * Pulse-specific user configuration, keyed by the OSN profile id.
 *
 * Kept in `pulse/db` (not `osn/db`) so that identity data (name, etc.)
 * stays owned by OSN and app-specific preferences live alongside the app's
 * own data. No foreign key — the `profileId` references `osn_db.users.id`
 * across a cross-DB boundary.
 *
 * Rows are created lazily on first Pulse write (RSVP, event creation, or
 * explicit settings update). Readers fall back to defaults when no row exists.
 */
export const pulseUsers = sqliteTable("pulse_users", {
  profileId: text("profile_id").primaryKey(),
  // "connections" → visible to the user's connections (default)
  // "no_one"      → hidden from everyone on Pulse
  //
  // Public-guest-list events override this setting: by attending such an
  // event the user implicitly accepts their RSVP is visible to anyone who
  // can see the event. Enforcement lives in `pulse/api/src/services/rsvps.ts`.
  attendanceVisibility: text("attendance_visibility", {
    enum: ["connections", "no_one"],
  })
    .notNull()
    .default("connections"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type PulseUser = typeof pulseUsers.$inferSelect;
export type NewPulseUser = typeof pulseUsers.$inferInsert;
