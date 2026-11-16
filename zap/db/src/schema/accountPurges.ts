import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * One row per account osn-api's deletion fan-out has erased from Zap, written
 * last in the batch that erases it (`zap/api/src/services/accountErasure.ts`).
 * A repeat of the same call finds the row and answers what the first one
 * kept, so osn-api gets the same answer whether or not it saw the first. It
 * holds a count, never message content. `account_id` is an opaque osn-db
 * account id with no foreign key; once osn-api has hard-deleted the account
 * it names no one.
 */
export const zapAccountPurges = sqliteTable("zap_account_purges", {
  accountId: text("account_id").primaryKey(),
  /** Unix seconds. */
  processedAt: integer("processed_at").notNull(),
  /**
   * The end-to-end messages the account had sent into chats that still had
   * other members, which stay there without its name.
   */
  keptMessages: integer("kept_messages").notNull(),
});

export type ZapAccountPurge = typeof zapAccountPurges.$inferSelect;
