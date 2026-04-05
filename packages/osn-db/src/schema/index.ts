import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(), // "usr_" prefix
    handle: text("handle").notNull().unique(), // @handle — immutable social identity
    email: text("email").notNull().unique(),
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  // users_email_idx kept for explicit query planning; handle UNIQUE constraint
  // already provides an implicit index so no separate handle index is needed.
  (t) => [index("users_email_idx").on(t.email)],
);

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(), // "pk_" prefix
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    credentialId: text("credential_id").notNull().unique(), // Base64URL from WebAuthn
    publicKey: text("public_key").notNull(), // base64 of Uint8Array
    counter: integer("counter").notNull().default(0),
    transports: text("transports"), // JSON of AuthenticatorTransport[]
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("passkeys_user_id_idx").on(t.userId)],
);

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Passkey = typeof passkeys.$inferSelect;
export type NewPasskey = typeof passkeys.$inferInsert;

// ---------------------------------------------------------------------------
// Social graph
// ---------------------------------------------------------------------------

export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(), // "conn_" prefix
    requesterId: text("requester_id")
      .notNull()
      .references(() => users.id),
    addresseeId: text("addressee_id")
      .notNull()
      .references(() => users.id),
    /** pending → accepted | pending → rejected (rejected rows are deleted) */
    status: text("status", { enum: ["pending", "accepted"] })
      .notNull()
      .default("pending"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    unique("connections_pair_idx").on(t.requesterId, t.addresseeId),
    index("connections_requester_idx").on(t.requesterId),
    index("connections_addressee_idx").on(t.addresseeId),
  ],
);

export const closeFriends = sqliteTable(
  "close_friends",
  {
    id: text("id").primaryKey(), // "clf_" prefix
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    friendId: text("friend_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    unique("close_friends_pair_idx").on(t.userId, t.friendId),
    index("close_friends_user_idx").on(t.userId),
  ],
);

export const blocks = sqliteTable(
  "blocks",
  {
    id: text("id").primaryKey(), // "blk_" prefix
    blockerId: text("blocker_id")
      .notNull()
      .references(() => users.id),
    blockedId: text("blocked_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    unique("blocks_pair_idx").on(t.blockerId, t.blockedId),
    index("blocks_blocker_idx").on(t.blockerId),
    index("blocks_blocked_idx").on(t.blockedId),
  ],
);

export type Connection = typeof connections.$inferSelect;
export type NewConnection = typeof connections.$inferInsert;
export type CloseFriend = typeof closeFriends.$inferSelect;
export type NewCloseFriend = typeof closeFriends.$inferInsert;
export type Block = typeof blocks.$inferSelect;
export type NewBlock = typeof blocks.$inferInsert;
