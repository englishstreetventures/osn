import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Per-profile soft-delete tombstones for "leave Pulse" (Flow B of C-H2).
 *
 * Independent from osn-api's `deletion_jobs` table (which tracks full-account
 * OSN-level erasure). A user can be in this table without being deleted from
 * OSN — they're just leaving Pulse — and a full OSN-level delete will create
 * a row here only via the cross-service ARC fan-out (treated as a Pulse
 * leave-app event under the hood).
 *
 * Lifecycle:
 *   1. Soft-delete: insert row, set Pulse data to scheduled-deletion state
 *      (rsvps + close-friends + comms hard-deleted; hosted events flipped
 *      to `cancelled_at` with a 14-day public-cancellation window;
 *      `pulse_users` deleted).
 *   2. After `hard_delete_at`, the sweeper purges any residual rows tied
 *      to this profile and removes the deletion_jobs row.
 *
 * `enrollment_notify_done_at` tracks the ARC callback to osn-api flipping
 * `app_enrollments.left_at`. NULL = retry pending (sweeper handles).
 */
export const pulseDeletionJobs = sqliteTable(
  "pulse_deletion_jobs",
  {
    /** PK = profileId — one in-flight Pulse deletion per profile. */
    profileId: text("profile_id").primaryKey(),
    /** Cross-DB ref to osn-db accounts.id (no FK). Used to call back to osn-api. */
    accountId: text("account_id").notNull(),
    /** Unix seconds. */
    softDeletedAt: integer("soft_deleted_at").notNull(),
    /** Unix seconds. softDeletedAt + 7 days. */
    hardDeleteAt: integer("hard_delete_at").notNull(),
    /** Unix seconds. Set when osn-api confirms `app_enrollments.left_at` flip. */
    enrollmentNotifyDoneAt: integer("enrollment_notify_done_at"),
    /** "user_request" | "osn_account_delete" | "admin". */
    reason: text("reason").notNull().default("user_request"),
  },
  (t) => [
    index("pulse_deletion_jobs_hard_delete_idx").on(t.hardDeleteAt),
    index("pulse_deletion_jobs_account_idx").on(t.accountId),
  ],
);

export type PulseDeletionJob = typeof pulseDeletionJobs.$inferSelect;
export type NewPulseDeletionJob = typeof pulseDeletionJobs.$inferInsert;

/**
 * Replay-protection ledger for the ARC-gated `/internal/account-deleted`
 * endpoint (S-H1). Without this, a captured `account:erase` ARC token (or
 * a compromised osn-api key) could be replayed against pulse-api with
 * arbitrary `accountId`/`profileIds[]` to nuke any user's Pulse data.
 *
 * The endpoint inserts a row keyed by `accountId` on first call; subsequent
 * calls short-circuit to a no-op `{ ok: true, purged: 0 }`. Rows are kept
 * indefinitely — they're 32 bytes each and the row count is bounded by
 * the lifetime number of full-account deletions across the platform.
 */
export const pulseAccountPurges = sqliteTable("pulse_account_purges", {
  accountId: text("account_id").primaryKey(),
  /** Unix seconds. */
  processedAt: integer("processed_at").notNull(),
  /** Number of profile rows purged on this call (logging / audit). */
  profileCount: integer("profile_count").notNull(),
});

export type PulseAccountPurge = typeof pulseAccountPurges.$inferSelect;
export type NewPulseAccountPurge = typeof pulseAccountPurges.$inferInsert;
