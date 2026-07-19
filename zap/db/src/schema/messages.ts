import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

import { chats } from "./chats";

/**
 * Messages support two content paths, determined by the parent chat's `class`:
 *
 * - c2c (consumer-to-consumer, E2E): `ciphertext` + `nonce` are populated;
 *   `body` is null. The server never sees plaintext.
 *   `ciphertext` holds the encrypted message body as base64 text;
 *   `nonce` holds the IV/nonce used for encryption.
 *
 * - c2b (consumer-to-business, server-visible): `body` is populated;
 *   `ciphertext` + `nonce` are null. The server can read, moderate, and
 *   include these messages in DSAR exports.
 *
 * Exactly one path is populated per message — enforced in the service layer
 * by chat class. All three columns are nullable at the DB level.
 *
 * The encryption protocol for c2c (Signal sender-keys vs MLS) is a deferred
 * decision — this schema accepts opaque blobs regardless of protocol.
 */
export const messages = sqliteTable(
  "messages",
  {
    id: text("id").primaryKey(), // "msg_" prefix
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id),
    senderProfileId: text("sender_profile_id").notNull(), // references osn-db users (cross-DB, no FK)
    // c2c (E2E) messages carry ciphertext+nonce; c2b (server-visible) messages
    // carry `body`. Exactly one path is populated per message — enforced in the
    // service layer by chat class. All three are nullable at the DB level.
    ciphertext: text("ciphertext"),
    nonce: text("nonce"),
    body: text("body"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
  },
  (t) => [
    index("messages_chat_idx").on(t.chatId),
    index("messages_chat_created_idx").on(t.chatId, t.createdAt),
    index("messages_sender_idx").on(t.senderProfileId),
  ],
);

export type Message = typeof messages.$inferSelect;
export type NewMessage = typeof messages.$inferInsert;
