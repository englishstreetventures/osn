import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Pulse first-run onboarding state, keyed by OSN accountId so a user with
 * multiple profiles on the same account only onboards once.
 *
 * `accountId` is server-side-only (it never appears in access-token claims
 * or user-facing API responses — see `osn/api/tests/privacy.test.ts`). The
 * mapping from JWT-asserted `profileId` to `accountId` is resolved over
 * ARC via `pulse/api/src/services/graphBridge.ts:getAccountIdForProfile`
 * and cached locally in `pulse_profile_accounts` so the cross-service hop
 * happens at most once per profile.
 *
 * Permission outcome columns store the resolved platform permission state
 * at the time the user finished onboarding. They are advisory metadata
 * for the UI ("you previously denied notifications, here's how to enable
 * them again"); the actual runtime behaviour is always re-checked from
 * the platform on use.
 */
export const pulseAccountOnboarding = sqliteTable("pulse_account_onboarding", {
  accountId: text("account_id").primaryKey(),
  completedAt: integer("completed_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  /** JSON-encoded `string[]` of selected interest categories, capped at 8 entries. */
  interests: text("interests").notNull().default("[]"),
  notificationsOptIn: integer("notifications_opt_in", { mode: "boolean" }).notNull().default(false),
  eventRemindersOptIn: integer("event_reminders_opt_in", { mode: "boolean" })
    .notNull()
    .default(false),
  /** Platform permission outcome at finish. `prompt` = never asked. */
  notificationsPerm: text("notifications_perm", {
    enum: ["granted", "denied", "prompt", "unsupported"],
  })
    .notNull()
    .default("prompt"),
  locationPerm: text("location_perm", {
    enum: ["granted", "denied", "prompt", "unsupported"],
  })
    .notNull()
    .default("prompt"),
});

export type PulseAccountOnboarding = typeof pulseAccountOnboarding.$inferSelect;
export type NewPulseAccountOnboarding = typeof pulseAccountOnboarding.$inferInsert;

/**
 * Cached `profileId → accountId` mapping. The mapping is immutable from
 * Pulse's perspective (OSN does not move profiles between accounts), so
 * a cache hit is authoritative. Populated lazily by the onboarding
 * service on first need; the row also lets future Pulse features that
 * key by account avoid an extra S2S round-trip.
 */
export const pulseProfileAccounts = sqliteTable(
  "pulse_profile_accounts",
  {
    profileId: text("profile_id").primaryKey(),
    accountId: text("account_id").notNull(),
    fetchedAt: integer("fetched_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (t) => [index("pulse_profile_accounts_account_idx").on(t.accountId)],
);

export type PulseProfileAccount = typeof pulseProfileAccounts.$inferSelect;
export type NewPulseProfileAccount = typeof pulseProfileAccounts.$inferInsert;
