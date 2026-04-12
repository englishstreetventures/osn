import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { chats } from "./chats";

/**
 * Messages store E2E-encrypted payloads. The server never sees plaintext.
 *
 * `ciphertext` holds the encrypted message body as base64 text.
 * `nonce` holds the IV/nonce used for encryption.
 *
 * The encryption protocol (Signal sender-keys vs MLS) is a deferred
 * decision — this schema accepts opaque blobs regardless of protocol.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(), // "msg_" prefix
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id),
    senderUserId: text("sender_user_id").notNull(), // references osn-db users (cross-DB, no FK)
    ciphertext: text("ciphertext").notNull(),
    nonce: text("nonce").notNull(),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
  },
  (t) => [
    index("messages_chat_idx").on(t.chatId),
    index("messages_chat_created_idx").on(t.chatId, t.createdAt),
    index("messages_sender_idx").on(t.senderUserId),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
