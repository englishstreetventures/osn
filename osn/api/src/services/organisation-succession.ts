/**
 * Who an organisation passes to when its owner goes: at the hard delete of the
 * owner's account (`account-erasure.ts`), and when a member who received it by
 * succession declines it (`organisation.ts`, `declineOwnership`). Both read the
 * same order, so a decline hands the organisation on exactly as the hard
 * delete would have without the decliner.
 */

import type { SQL } from "drizzle-orm";
import { sql } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/**
 * How long a member who received an organisation by succession may decline
 * it: 30 days from `organisations.owner_inherited_at`, the same span a deleted
 * account's handles stay held.
 */
export const OWNERSHIP_DECLINE_WINDOW_SECONDS = 30 * 24 * 60 * 60;

/**
 * `organisation_members` of `orgId` whose profile belongs to an account other
 * than `accountId`, best successor first: admins before members ('admin'
 * sorts before 'member', the only two roles the triggers allow), then the
 * longest-standing, then by id. That is the order of
 * `org_members_succession_idx`, so the read walks the index and stops at the
 * first member from another account. `column` picks what the subquery answers.
 */
export const successorRow = (
  column: "id" | "profile_id",
  orgId: SQL | AnySQLiteColumn,
  accountId: string,
): SQL =>
  sql`(SELECT m.${sql.raw(column)} FROM organisation_members m JOIN users u ON u.id = m.profile_id
    WHERE m.organisation_id = ${orgId} AND u.account_id <> ${accountId}
    ORDER BY m.role, m.created_at, m.id LIMIT 1)`;
