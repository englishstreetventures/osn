import { sql } from "drizzle-orm";
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
  /**
   * Unix seconds. Non-null when the account is in the soft-deleted (tombstoned)
   * state — Art. 17 erasure has been requested and the row is awaiting
   * hard-delete by the deletion sweeper after the 7-day grace window.
   * Tombstoned accounts cannot mint or refresh access tokens.
   */
  deletedAt: integer("deleted_at"),
  /**
   * Unix seconds. Non-null when the account is under Art. 18 processing
   * restriction (e.g. pending dispute). The account cannot mutate state
   * but data is preserved.
   */
  processingRestrictedAt: integer("processing_restricted_at"),
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
    /**
     * User-editable friendly name for this passkey. Defaulted at enrolment
     * from the `aaguid` lookup ("iCloud Keychain", "Windows Hello", …) and
     * editable from Settings → Passkeys. Optional: older rows can be null.
     */
    label: text("label"),
    /**
     * Unix seconds of the most recent successful authentication or step-up
     * ceremony. Drives the "last used" column in Settings → Passkeys so the
     * user can spot a stale credential at a glance.
     */
    lastUsedAt: integer("last_used_at"),
    /**
     * Authenticator-model UUID from WebAuthn attestation. Not a secret; the
     * FIDO MDS publishes the full list. We keep it so a future migration can
     * backfill `label` from the MDS name map without re-prompting the user.
     */
    aaguid: text("aaguid"),
    /** WebAuthn `backupEligible` bit — does this authenticator support sync? */
    backupEligible: integer("backup_eligible", { mode: "boolean" }),
    /** WebAuthn `backupState` bit — has this credential been synced yet? */
    backupState: integer("backup_state", { mode: "boolean" }),
    /**
     * Unix seconds for the most recent metadata change (rename, counter
     * update, sync-state flip). `createdAt` stays immutable. Indexing
     * `last_used_at` alone would miss renames; a dedicated updatedAt is
     * cleaner than over-reading the hot last_used_at column.
     */
    updatedAt: integer("updated_at"),
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
     * Coarse UA label, e.g. "Firefox on macOS". Derived from the User-Agent
     * header at session-issue time and never stored raw — we keep
     * cardinality bounded to ~browser × OS so Settings UI can render a
     * recognisable device list without turning this into a fingerprint.
     */
    uaLabel: text("ua_label"),
    /**
     * HMAC-SHA256(peppered, client-IP), hex-encoded. Rainbow-table resistant
     * handle for the issuing IP. Only used to let the owner recognise which
     * session is which — never exposed beyond the caller's own list.
     */
    ipHash: text("ip_hash"),
    /** Unix seconds. Updated on every successful refresh/verify hit. */
    lastUsedAt: integer("last_used_at"),
  },
  (t) => [
    index("sessions_account_idx").on(t.accountId),
    index("sessions_family_idx").on(t.familyId),
    // P-W2: composite index serves ORDER BY last_used_at DESC for
    // listAccountSessions + LRU eviction scan in issueTokens.
    index("sessions_account_last_used_idx").on(t.accountId, t.lastUsedAt),
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
// Email change audit log
//
// Captures completed email-address changes so we can enforce a "max 2 changes
// per 7 days" cap (a soft anti-abuse guard — low enough to curb account-stuff
// churn, high enough to forgive a legitimate typo + correction). Rows stay
// after the window expires for audit purposes; the cap only counts rows
// completed inside the trailing 7-day window.
// ---------------------------------------------------------------------------

export const emailChanges = sqliteTable(
  "email_changes",
  {
    id: text("id").primaryKey(), // "ech_" prefix
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    previousEmail: text("previous_email").notNull(),
    newEmail: text("new_email").notNull(),
    /** Unix seconds */
    completedAt: integer("completed_at").notNull(),
  },
  (t) => [
    index("email_changes_account_idx").on(t.accountId),
    index("email_changes_completed_at_idx").on(t.completedAt),
  ],
);

export type EmailChange = typeof emailChanges.$inferSelect;
export type NewEmailChange = typeof emailChanges.$inferInsert;

// ---------------------------------------------------------------------------
// Security events (M-PK1b)
//
// Out-of-band audit trail for account-level security actions. Every row is
// created alongside the primary action (e.g. recovery-code regeneration) so
// a UI banner can surface "did you do this?" to the account holder even if
// the attacker suppressed the confirmation email.
//
// `kind` is a bounded string enum — see SecurityEventKind in
// @shared/observability/metrics. New kinds get added there first so the
// metric attribute union stays in sync with the schema column.
//
// Rows are created per-event; `acknowledged_at` goes from NULL → unix seconds
// when the user dismisses the banner. We keep acknowledged rows for audit
// (the banner just stops surfacing them).
// ---------------------------------------------------------------------------

export const securityEvents = sqliteTable(
  "security_events",
  {
    id: text("id").primaryKey(), // "sev_" prefix
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /**
     * Bounded kind enum — see SecurityEventKind in @shared/observability.
     * Enforced at the service boundary, not the column level, so adding
     * a new kind doesn't require a schema migration.
     */
    kind: text("kind").notNull(),
    /** Unix seconds */
    createdAt: integer("created_at").notNull(),
    /** Unix seconds — NULL while the banner is still surfacing. */
    acknowledgedAt: integer("acknowledged_at"),
    /** HMAC-peppered IP hash of the request that triggered the event (optional). */
    ipHash: text("ip_hash"),
    /** Coarse UA label captured at event time ("Firefox on macOS"). */
    uaLabel: text("ua_label"),
  },
  (t) => [
    // P-W1: partial index over the hot "unacknowledged" slice. Acked rows
    // are kept for audit but grow unbounded over time; the Settings banner
    // only reads unacked rows, so excluding acked rows from the index keeps
    // it tiny regardless of history. Column order (account_id, created_at DESC)
    // also satisfies the `ORDER BY created_at DESC` on the list query so
    // SQLite serves the sort from the index instead of materialising it.
    index("security_events_unacked_idx")
      .on(t.accountId, t.createdAt)
      .where(sql`${t.acknowledgedAt} IS NULL`),
  ],
);

export type SecurityEvent = typeof securityEvents.$inferSelect;
export type NewSecurityEvent = typeof securityEvents.$inferInsert;

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

// ---------------------------------------------------------------------------
// App enrollments (C-H2 — modular platform opt-in tracking)
//
// One row per (account, app, joined-at). `leftAt` stays NULL while the user
// is currently enrolled. When a user "leaves Pulse" (Flow B) we set leftAt
// rather than deleting the row, preserving an audit trail of join/leave
// history. A re-join writes a new row with a fresh joined_at.
//
// Read pattern: `WHERE account_id = ? AND app = ? AND left_at IS NULL`
// returns at most one row — used by the OSN-level deletion fan-out to know
// which apps to ARC-call and by Pulse to know whether to provision a
// pulse_users row.
// ---------------------------------------------------------------------------

export const appEnrollments = sqliteTable(
  "app_enrollments",
  {
    id: text("id").primaryKey(), // "aenr_" prefix
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id),
    /** App identifier — "pulse" | "zap" (kept loose at the column to allow new apps without migration). */
    app: text("app").notNull(),
    /** Unix seconds — first authenticated interaction with the app. */
    joinedAt: integer("joined_at").notNull(),
    /** Unix seconds. NULL = currently enrolled. Set on app-scoped delete. */
    leftAt: integer("left_at"),
  },
  (t) => [
    index("app_enrollments_account_idx").on(t.accountId),
    index("app_enrollments_active_idx")
      .on(t.accountId, t.app)
      .where(sql`${t.leftAt} IS NULL`),
  ],
);

export type AppEnrollment = typeof appEnrollments.$inferSelect;
export type NewAppEnrollment = typeof appEnrollments.$inferInsert;

// ---------------------------------------------------------------------------
// Deletion jobs (C-H2 — Art. 17 right-to-erasure tombstones)
//
// One row per soft-delete. Row exists for the full 7-day grace window and
// for the post-grace fan-out window until the hard-delete sweeper removes
// the underlying account rows and this job. Idempotent re-requests return
// the existing scheduledFor without inserting a duplicate.
//
// `*_done_at` columns track per-bridge fan-out completion. The hard-delete
// sweeper refuses to fire until both are non-null AND `now >= hard_delete_at`.
// Bridges not in this account's enrolled-apps set at soft-delete time are
// pre-marked done (via a sentinel timestamp) so the gate doesn't block on
// services the user never used.
// ---------------------------------------------------------------------------

export const deletionJobs = sqliteTable(
  "deletion_jobs",
  {
    /** PK = accountId (one in-flight deletion per account at a time). */
    accountId: text("account_id")
      .primaryKey()
      .references(() => accounts.id),
    /** Unix seconds. */
    softDeletedAt: integer("soft_deleted_at").notNull(),
    /** Unix seconds. softDeletedAt + 7 days. */
    hardDeleteAt: integer("hard_delete_at").notNull(),
    /** Unix seconds. Set by the Pulse purge bridge when its work is done. */
    pulseDoneAt: integer("pulse_done_at"),
    /** Unix seconds. Set by the Zap purge bridge when its work is done. */
    zapDoneAt: integer("zap_done_at"),
    /** Trigger source — "user_request" | "minor_detected" | "admin". */
    reason: text("reason").notNull().default("user_request"),
    /**
     * The session id (hashed) that requested the deletion. Kept alive
     * during the grace window as the cancellation handle — the user can
     * cancel by re-authenticating with this session. All other sessions
     * for the account are revoked at soft-delete time.
     */
    cancelSessionId: text("cancel_session_id"),
  },
  (t) => [
    // Sweeper scan: rows ready for hard-delete.
    index("deletion_jobs_hard_delete_idx").on(t.hardDeleteAt),
    // Retry sweeper scan: pending fan-out.
    index("deletion_jobs_pulse_pending_idx")
      .on(t.softDeletedAt)
      .where(sql`${t.pulseDoneAt} IS NULL`),
    index("deletion_jobs_zap_pending_idx")
      .on(t.softDeletedAt)
      .where(sql`${t.zapDoneAt} IS NULL`),
  ],
);

export type DeletionJob = typeof deletionJobs.$inferSelect;
export type NewDeletionJob = typeof deletionJobs.$inferInsert;
