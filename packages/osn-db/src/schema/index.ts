import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

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
