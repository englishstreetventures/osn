import { sqliteTable, text, integer, index, unique } from "drizzle-orm/sqlite-core";

// ---------------------------------------------------------------------------
// Accounts (authentication principal — invisible externally)
// ---------------------------------------------------------------------------

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(), // "acc_" prefix
  email: text("email").notNull().unique(),
  passkeyUserId: text("passkey_user_id").notNull().unique(), // random UUID, opaque WebAuthn user.id (never correlates to accountId)
  maxProfiles: integer("max_profiles").notNull().default(5),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;

// ---------------------------------------------------------------------------
// Users / Profiles (public-facing identity — the canonical entity everywhere)
// ---------------------------------------------------------------------------

export const users = sqliteTable(
  "users",
  {
    id: text("id").primaryKey(), // "usr_" prefix
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    handle: text("handle").notNull().unique(), // @handle — immutable social identity
    displayName: text("display_name"),
    avatarUrl: text("avatar_url"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("users_account_idx").on(t.accountId)],
);

export const passkeys = sqliteTable(
  "passkeys",
  {
    id: text("id").primaryKey(), // "pk_" prefix
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    credentialId: text("credential_id").notNull().unique(), // Base64URL from WebAuthn
    publicKey: text("public_key").notNull(), // base64 of Uint8Array
    counter: integer("counter").notNull().default(0),
    transports: text("transports"), // JSON of AuthenticatorTransport[]
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("passkeys_account_id_idx").on(t.accountId)],
);

export type Profile = typeof users.$inferSelect;
export type NewProfile = typeof users.$inferInsert;
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
    profileId: text("profile_id")
      .notNull()
      .references(() => users.id),
    friendId: text("friend_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    unique("close_friends_pair_idx").on(t.profileId, t.friendId),
    index("close_friends_profile_idx").on(t.profileId),
    index("close_friends_friend_idx").on(t.friendId),
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

// ---------------------------------------------------------------------------
// Service accounts (ARC token S2S auth)
// ---------------------------------------------------------------------------

export const serviceAccounts = sqliteTable("service_accounts", {
  serviceId: text("service_id").primaryKey(), // e.g. "pulse-api", "messaging"
  allowedScopes: text("allowed_scopes").notNull(), // comma-separated: "graph:read,graph:write"
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
});

export type ServiceAccount = typeof serviceAccounts.$inferSelect;
export type NewServiceAccount = typeof serviceAccounts.$inferInsert;

/**
 * Per-key rows for a service account. Supports multiple active keys during
 * rotation (zero-downtime key roll). Public key material lives here;
 * allowed scopes live in service_accounts.
 *
 * Rotation flow:
 *   1. Register new key row (expiresAt = now + TTL)
 *   2. Service starts signing with new key
 *   3. Old key row expires naturally after tokens bearing it have expired (≤5 min TTL)
 *   4. Optionally revoke old key early by setting revokedAt
 */
export const serviceAccountKeys = sqliteTable(
  "service_account_keys",
  {
    keyId: text("key_id").primaryKey(), // UUID, becomes `kid` in JWT header
    serviceId: text("service_id")
      .notNull()
      .references(() => serviceAccounts.serviceId),
    publicKeyJwk: text("public_key_jwk").notNull(), // JSON-serialised JWK (ES256)
    registeredAt: integer("registered_at", { mode: "timestamp" }).notNull(),
    /** Unix seconds. NULL = key does not expire (pre-distributed stable keys). */
    expiresAt: integer("expires_at"), // nullable — plain seconds, no timestamp mode
    /** Unix seconds. Non-null when the key has been explicitly revoked. */
    revokedAt: integer("revoked_at"), // nullable — plain seconds
  },
  (t) => [index("service_account_keys_service_idx").on(t.serviceId)],
);

export type ServiceAccountKey = typeof serviceAccountKeys.$inferSelect;
export type NewServiceAccountKey = typeof serviceAccountKeys.$inferInsert;

// ---------------------------------------------------------------------------
// Sessions (server-side session store — Copenhagen Book C1)
//
// Refresh tokens are opaque (20 random bytes, hex-encoded, `ses_` prefix).
// The raw token is held by the client; the server stores only the SHA-256
// hash as the primary key. A database leak therefore does not expose valid
// session tokens (same principle as password hashing, but SHA-256 suffices
// because the token already has 160 bits of entropy).
//
// Sliding-window expiry: when less than half the TTL remains, `expiresAt`
// is extended to `now + TTL` on the next verification.
// ---------------------------------------------------------------------------

export const sessions = sqliteTable(
  "sessions",
  {
    /** SHA-256(raw session token), hex-encoded */
    id: text("id").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /**
     * Session family identifier — all rotated tokens in a refresh chain
     * share this value. Enables reuse detection: if a revoked token's
     * family is seen again, revoke the entire family. Generated once at
     * login (`sfam_` prefix); propagated on rotation.
     */
    familyId: text("family_id").notNull(),
    /** Unix seconds */
    expiresAt: integer("expires_at").notNull(),
    /** Unix seconds */
    createdAt: integer("created_at").notNull(),
    /**
     * Device metadata (session management). Populated on issue + refresh so
     * the user-facing session list can show where each session is active
     * and the current device can be flagged.
     *
     * - `userAgent`: raw User-Agent header. Not normalised — the UI parses it
     *   for display, but the raw string is what the server stores for fidelity.
     * - `ipHash`: SHA-256 of `clientIp + OSN_IP_HASH_SALT`. Coarse fingerprint
     *   — enough to say "same device as last week" without the PII / precision
     *   of storing the raw IP. Salt rotates invalidate historic equality, which
     *   is acceptable.
     * - `deviceLabel`: user-set nickname (future). Null until the user renames.
     * - `lastSeenAt`: unix seconds, updated on every `verifyRefreshToken`. The
     *   session list sorts descending on this.
     * - `createdIpHash`: same hash format as ipHash but pinned at session-create
     *   time. Surfaced in the UI as "signed in from …" alongside the current
     *   location to make session hijack more visible.
     */
    userAgent: text("user_agent"),
    ipHash: text("ip_hash"),
    deviceLabel: text("device_label"),
    lastSeenAt: integer("last_seen_at").notNull(),
    createdIpHash: text("created_ip_hash"),
  },
  (t) => [
    index("sessions_account_idx").on(t.accountId),
    index("sessions_family_idx").on(t.familyId),
    index("sessions_last_seen_idx").on(t.lastSeenAt),
  ],
);

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

// ---------------------------------------------------------------------------
// Recovery codes (Copenhagen Book M2)
//
// Single-use account-recovery tokens. Only the SHA-256 hash of the code is
// stored; the raw codes are shown to the user exactly once at generation
// time. Regenerating wipes the previous set (see service.generateRecoveryCodes).
// A successful `consume` revokes all active sessions (the recovery ceremony
// establishes a fresh session anyway).
// ---------------------------------------------------------------------------

export const recoveryCodes = sqliteTable(
  "recovery_codes",
  {
    id: text("id").primaryKey(), // "rec_" prefix
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /** SHA-256(normalised raw code), hex-encoded */
    codeHash: text("code_hash").notNull().unique(),
    /** Unix seconds. Set when the code is consumed; remains for audit purposes. */
    usedAt: integer("used_at"),
    /** Unix seconds. */
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("recovery_codes_account_idx").on(t.accountId)],
);

export type RecoveryCode = typeof recoveryCodes.$inferSelect;
export type NewRecoveryCode = typeof recoveryCodes.$inferInsert;

// ---------------------------------------------------------------------------
// Organisations
// ---------------------------------------------------------------------------

export const organisations = sqliteTable(
  "organisations",
  {
    id: text("id").primaryKey(), // "org_" prefix
    handle: text("handle").notNull().unique(), // shared namespace with user handles
    name: text("name").notNull(),
    description: text("description"),
    avatarUrl: text("avatar_url"),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("organisations_owner_idx").on(t.ownerId)],
);

export const organisationMembers = sqliteTable(
  "organisation_members",
  {
    id: text("id").primaryKey(), // "orgm_" prefix
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id),
    profileId: text("profile_id")
      .notNull()
      .references(() => users.id),
    role: text("role", { enum: ["admin", "member"] }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    unique("org_members_pair_idx").on(t.organisationId, t.profileId),
    index("org_members_org_idx").on(t.organisationId),
    index("org_members_profile_idx").on(t.profileId),
  ],
);

export type Organisation = typeof organisations.$inferSelect;
export type NewOrganisation = typeof organisations.$inferInsert;
export type OrganisationMember = typeof organisationMembers.$inferSelect;
export type NewOrganisationMember = typeof organisationMembers.$inferInsert;
