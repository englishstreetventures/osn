import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

export const chats = sqliteTable(
  "chats",
  {
    id: text("id").primaryKey(), // "chat_" prefix
    // "dm"    → 1:1 direct message
    // "group" → user-created group chat
    // "event" → Pulse event chat (provisioned via zapBridge)
    type: text("type", { enum: ["dm", "group", "event"] }).notNull(),
    // Relationship class — the encryption/visibility axis, orthogonal to `type`.
    // "c2c" = consumer-to-consumer: personal, E2E (messages carry ciphertext/nonce).
    // "c2b" = consumer-to-business: server-visible (messages carry plaintext `body`),
    // moderatable, and included in DSAR export. Defaults to "c2c" so existing rows
    // and any insert that omits it stay personal.
    class: text("class", { enum: ["c2c", "c2b"] })
      .notNull()
      .default("c2c"),
    title: text("title"),
    // Opaque reference to a Pulse event. Only populated for type = "event".
    // NOT a foreign key (cross-DB boundary — different SQLite files).
    eventId: text("event_id"),
    createdByProfileId: text("created_by_profile_id").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: integer("updated_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    index("chats_type_idx").on(t.type),
    // No index on `class`. It has two values and they are heavily skewed
    // (c2c greatly outnumbers c2b), and the one query that filters on it
    // (`loadC2bMessages`, `zap/api/src/routes/internal.ts`) reaches `chats`
    // through an inner join on the primary key — `EXPLAIN QUERY PLAN` gives
    // the identical plan with the index and without it:
    //
    //   SEARCH m USING INDEX chat_members_profile_idx (profile_id=?)
    //   SEARCH c USING INDEX sqlite_autoindex_chats_1 (id=?)
    //
    // So it was never an access path, only a write to maintain on every chat
    // insert. Add a partial `WHERE class = 'c2b'` index if a query ever scans
    // chats by class alone.
    index("chats_event_id_idx").on(t.eventId),
    index("chats_created_by_profile_id_idx").on(t.createdByProfileId),
  ],
);

export type Chat = typeof chats.$inferSelect;
export type NewChat = typeof chats.$inferInsert;
