import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

import { eventSeries } from "./eventSeries";

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
    // ── Status ────────────────────────────────────────────────────────────
    // "upcoming"        → startTime in the future
    // "ongoing"         → startTime past, endTime (explicit or implied) still in the future
    // "maybe_finished"  → no explicit endTime + >= 8h past startTime; grace window
    //                     before auto-closing (organiser can still mark finished early)
    // "finished"        → endTime reached OR no-endTime event auto-closed after 12h
    //                     OR organiser manually closed
    // "cancelled"       → organiser cancelled
    status: text("status", {
      enum: ["upcoming", "ongoing", "maybe_finished", "finished", "cancelled"],
    })
      .notNull()
      .default("upcoming"),
    imageUrl: text("image_url"),
    // ── Price ─────────────────────────────────────────────────────────────
    // Stored in minor units (cents/pence/etc.) so "$18.50" = 1850. Use a
    // currency-aware formatter at display time. Both columns set or both
    // null — enforced at the service layer. null OR 0 → "Free".
    priceAmount: integer("price_amount"),
    priceCurrency: text("price_currency"),
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
    // ── Series membership ────────────────────────────────────────────────
    // When non-null, this event is an instance of a recurring series. Edits
    // to the series template only propagate to instances with
    // `instance_override = false`; single-instance edits flip the flag true.
    seriesId: text("series_id").references(() => eventSeries.id),
    instanceOverride: integer("instance_override", { mode: "boolean" }).notNull().default(false),
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
    // Discovery always ANDs visibility with a time window, so a compound
    // (visibility, start_time) index lets the query planner use a single
    // seek instead of visibility-filter + sort.
    index("events_visibility_start_time_idx").on(t.visibility, t.startTime),
    // Discovery filter dimension.
    index("events_category_idx").on(t.category),
    // Discovery bbox prefilter. SQLite has no geo extension by default, so
    // radius search does a bbox range scan here + a JS haversine pass.
    index("events_lat_lng_idx").on(t.latitude, t.longitude),
    // Powers `GET /series/:id/instances` — walk a single series by start time.
    index("events_series_id_idx").on(t.seriesId, t.startTime),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
