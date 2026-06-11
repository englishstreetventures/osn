import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Venue — a physical place that hosts events. Currently scoped to clubs
 * (the first surface to use this), but the shape is generic enough to
 * extend to other venue types.
 *
 * Venues belong to an OSN organisation. The public URL is
 * `/venues/:orgHandle/:venueHandle` — the org handle namespaces the
 * venue handle so two venues across the network can share a handle (or
 * even a name) without collision. The `id` column is opaque and used
 * for foreign-key targets (events, lineup); never surfaced in URLs.
 *
 * Hours are stored as JSON keyed by ISO weekday number ("1".."7", Mon=1)
 * for compactness. The frontend parses + renders. Free-form null when
 * the venue has irregular / event-driven hours.
 */
export const venues = sqliteTable(
  "venues",
  {
    /** Opaque PK, e.g. `ven_basement_room`. Not URL-addressable. */
    id: text("id").primaryKey(),
    /** Owning OSN organisation handle (e.g. "underground-collective"). */
    orgHandle: text("org_handle").notNull(),
    /** URL handle, unique within the owning org (e.g. "basement-room"). */
    handle: text("handle").notNull(),
    name: text("name").notNull(),
    /** "club" | "bar" | "warehouse" | …. Free-form for now; bucket at metric time. */
    kind: text("kind").notNull().default("club"),
    description: text("description"),
    address: text("address"),
    city: text("city"),
    country: text("country"),
    latitude: real("latitude"),
    longitude: real("longitude"),
    /** Standing capacity (null = unknown / variable). */
    capacity: integer("capacity"),
    /**
     * JSON-encoded hours map keyed by ISO weekday ("1".."7", Mon=1).
     * Each value is `{ open: "HH:MM", close: "HH:MM" }` in the venue's
     * local time, or `null` for "closed". Null on the column means the
     * venue has no fixed schedule (event-driven).
     */
    hours: text("hours"),
    heroImageUrl: text("hero_image_url"),
    websiteUrl: text("website_url"),
    instagramHandle: text("instagram_handle"),
    /** IANA timezone (e.g. "Europe/London"). Lineup slot times render in this zone. */
    timezone: text("timezone").notNull().default("UTC"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("venues_kind_idx").on(t.kind),
    // Reuse the events bbox pattern — same JS-haversine prefilter when we
    // surface "venues near me".
    index("venues_lat_lng_idx").on(t.latitude, t.longitude),
    // Lookup target for `/venues/:orgHandle/:venueHandle`. Also enforces
    // uniqueness of (org_handle, handle).
    uniqueIndex("venues_org_handle_idx").on(t.orgHandle, t.handle),
  ],
);

export type Venue = typeof venues.$inferSelect;
export type NewVenue = typeof venues.$inferInsert;
