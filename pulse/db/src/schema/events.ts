import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    venue: text("venue"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    category: text("category"),
    startTime: integer("start_time", { mode: "timestamp" }).notNull(),
    endTime: integer("end_time", { mode: "timestamp" }),
    status: text("status", { enum: ["upcoming", "ongoing", "finished", "cancelled"] })
      .notNull()
      .default("upcoming"),
    imageUrl: text("image_url"),
    // ── Discovery ─────────────────────────────────────────────────────────
    // "public"  → surfaces in discovery / algorithm feeds
    // "private" → only reachable via direct link or invite
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    // ── Guest list visibility ─────────────────────────────────────────────
    // "public"      → anyone can see who's going
    // "connections" → only the organiser's connections can see the list
    // "private"     → only the organiser can see (others see counts only)
    // Each attendee's own profile attendanceVisibility may further narrow
    // visibility on a per-row basis (service-layer enforces both).
    guestListVisibility: text("guest_list_visibility", {
      enum: ["public", "connections", "private"],
    })
      .notNull()
      .default("public"),
    // ── Join policy ───────────────────────────────────────────────────────
    // "open"       → anyone with the link can RSVP going/interested/not_going
    // "guest_list" → only users explicitly invited (rsvp.status = "invited")
    //                can transition to going. Non-invited users are rejected.
    joinPolicy: text("join_policy", { enum: ["open", "guest_list"] })
      .notNull()
      .default("open"),
    // ── RSVP options ──────────────────────────────────────────────────────
    // When false, the service rejects rsvp.status = "interested"/"maybe".
    // Some organisers want a binary Going / Not going decision.
    allowInterested: integer("allow_interested", { mode: "boolean" }).notNull().default(true),
    // ── Communications ────────────────────────────────────────────────────
    // JSON-encoded array of the channels the organiser wants to use for
    // blasts. Must be at least one of "sms" | "email". Actual blast history
    // lives in the `event_comms` table (see rsvps/index.ts siblings).
    commsChannels: text("comms_channels").notNull().default('["email"]'),
    // ── Chat ──────────────────────────────────────────────────────────────
    // Opaque reference to a @zap/db chat. Populated when the organiser
    // enables event chat (provisioned via zapBridge). NOT a foreign key —
    // the chat lives in a different SQLite file.
    chatId: text("chat_id"),
    createdByProfileId: text("created_by_profile_id").notNull(),
    createdByName: text("created_by_name"),
    createdByAvatar: text("created_by_avatar"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("events_start_time_idx").on(t.startTime),
    index("events_created_by_profile_id_idx").on(t.createdByProfileId),
    index("events_visibility_idx").on(t.visibility),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
