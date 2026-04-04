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
    createdByUserId: text("created_by_user_id").notNull(),
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
    index("events_created_by_user_id_idx").on(t.createdByUserId),
  ],
);

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
