import { sqliteTable, text, integer, real, index } from "drizzle-orm/sqlite-core";

/**
 * Recurring event series — the template that `events` rows are materialised from.
 *
 * Instances live in the `events` table with `series_id` set to the series row's id.
 * Editing `event_series` row → bulk updates future non-override instances.
 * Editing a single `events` row sets `instance_override = true` so it survives
 * subsequent series-level edits.
 *
 * Chosen over a virtual/RRULE-on-read model because every existing discovery,
 * RSVP, ICS, comms, and map query already assumes a concrete `events.id`.
 */
export const eventSeries = sqliteTable(
  "event_series",
  {
    id: text("id").primaryKey(), // "srs_" prefix
    title: text("title").notNull(),
    description: text("description"),
    // Template fields mirroring the event defaults. Applied at materialize
    // time and propagated on subsequent bulk series updates to any
    // non-override instance.
    location: text("location"),
    venue: text("venue"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    category: text("category"),
    imageUrl: text("image_url"),
    durationMinutes: integer("duration_minutes"), // nullable — instance end_time stays null when unset
    visibility: text("visibility", { enum: ["public", "private"] })
      .notNull()
      .default("public"),
    guestListVisibility: text("guest_list_visibility", {
      enum: ["public", "connections", "private"],
    })
      .notNull()
      .default("public"),
    joinPolicy: text("join_policy", { enum: ["open", "guest_list"] })
      .notNull()
      .default("open"),
    allowInterested: integer("allow_interested", { mode: "boolean" }).notNull().default(true),
    commsChannels: text("comms_channels").notNull().default('["email"]'),
    // ── Recurrence ────────────────────────────────────────────────────────
    // Reduced-grammar RRULE: FREQ=WEEKLY|MONTHLY, INTERVAL, BYDAY, COUNT, UNTIL.
    // Parsed + expanded by `services/series.ts`. Full iCal RRULE deferred.
    rrule: text("rrule").notNull(),
    // First occurrence's start time. Expansion walks forward from here.
    dtstart: integer("dtstart", { mode: "timestamp" }).notNull(),
    // Optional hard end — if set, expansion stops here even when COUNT is unbounded.
    until: integer("until", { mode: "timestamp" }),
    // The expander writes concrete rows up to this watermark. A sweep
    // extends the window when the tail falls below a threshold.
    materializedThrough: integer("materialized_through", { mode: "timestamp" }).notNull(),
    // IANA timezone in which the recurrence is anchored (e.g. "America/New_York").
    // Needed so "every Tuesday 7pm" is stable across DST transitions.
    timezone: text("timezone").notNull().default("UTC"),
    status: text("status", { enum: ["active", "ended", "cancelled"] })
      .notNull()
      .default("active"),
    // Optional reference to a shared Zap chat for the whole series. Reserved
    // for Zap M2 — no FK (cross-DB).
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
  (t) => [index("event_series_created_by_idx").on(t.createdByProfileId)],
);

export type EventSeries = typeof eventSeries.$inferSelect;
export type NewEventSeries = typeof eventSeries.$inferInsert;
