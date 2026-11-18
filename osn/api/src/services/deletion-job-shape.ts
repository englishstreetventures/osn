/**
 * The one test for a deletion job written before the restore record existed:
 * `deletion_jobs.restore` is NULL. The soft delete that wrote such a job also
 * deleted the account's passkeys, recovery codes and TOTP, so the session it
 * kept is that account's only way to cancel. `cancelErasure` reads it to
 * restore the account only (no profiles, no enrolments); a sign-in over that
 * job's cancel handle (`endFamilyOfToken` in `auth/sessions.ts`) spares the
 * handle and marks it replaced instead of ending it.
 *
 * Removed with englishstreetventures/osn#2299.
 */

import { deletionJobs, type DeletionJob } from "@osn/db/schema";
import type { DbService } from "@osn/db/service";
import { and, eq, exists, isNull, sql, type SQL } from "drizzle-orm";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";

/** Whether `job` predates the restore record. */
export const jobPredatesRestoreRecord = (job: Pick<DeletionJob, "restore">): boolean =>
  job.restore === null;

/**
 * True for a row whose account has a pending deletion job that predates the
 * restore record: the same test as {@link jobPredatesRestoreRecord}, in SQL.
 */
export const accountHasJobPredatingRestoreRecord = (
  db: DbService["db"],
  accountColumn: AnySQLiteColumn,
): SQL =>
  exists(
    db
      .select({ one: sql`1` })
      .from(deletionJobs)
      .where(and(eq(deletionJobs.accountId, accountColumn), isNull(deletionJobs.restore))),
  );
