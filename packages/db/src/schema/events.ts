import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const events = sqliteTable("events", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  location: text("location"),
  venue: text("venue"),
  category: text("category"),
  startTime: integer("start_time", { mode: "timestamp" }).notNull(),
  endTime: integer("end_time", { mode: "timestamp" }),
  status: text("status", { enum: ["upcoming", "ongoing", "finished", "cancelled"] })
    .notNull()
    .default("upcoming"),
  imageUrl: text("image_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

export type Event = typeof events.$inferSelect;
export type NewEvent = typeof events.$inferInsert;
