import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";
import { chats } from "./chats";

export const chatMembers = sqliteTable(
  "chat_members",
  {
    id: text("id").primaryKey(), // "cmem_" prefix
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id),
    userId: text("user_id").notNull(), // references osn-db users (cross-DB, no FK)
    role: text("role", { enum: ["admin", "member"] })
      .notNull()
      .default("member"),
    joinedAt: integer("joined_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [
    unique("chat_members_pair_idx").on(t.chatId, t.userId),
    index("chat_members_chat_idx").on(t.chatId),
    index("chat_members_user_idx").on(t.userId),
  ],
);

export type ChatMember = typeof chatMembers.$inferSelect;
export type NewChatMember = typeof chatMembers.$inferInsert;
