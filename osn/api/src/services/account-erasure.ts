import { createHash } from "node:crypto";

import {
  accounts,
  appEnrollments,
  blocks,
  connections,
  deletionJobs,
  handleHolds,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsents,
  organisationMembers,
  organisations,
  passkeys,
  recoveryCodes,
  rotatedSessions,
  securityEvents,
  sessions,
  totpCredentials,
  users,
} from "@osn/db/schema";
import type { DeletionJob } from "@osn/db/schema";
import { Db, type DbService } from "@osn/db/service";
import { commitBatch, jsonEachIn, rowsChanged } from "@shared/db-utils";
import type { AppEnrollmentApp } from "@shared/observability/metrics";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNull,
  lte,
  ne,
  notExists,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { alias, type AnySQLiteColumn, type SQLiteUpdateSetSource } from "drizzle-orm/sqlite-core";
import { Cause, Data, Effect } from "effect";

import { canBatch } from "../lib/batch";
import { bound } from "../lib/bound";
import type { HeldHandleDigest } from "../lib/handle-hold";
import {
  metricAccountDeletionCompleted,
  metricAccountDeletionFanout,
  metricAccountDeletionFanoutOldestAge,
  metricAccountDeletionOrganisation,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  safeErrorSummary,
  withAccountDeletion,
} from "../metrics";
import { leaveApp } from "./app-enrollments";
import {
  appTarget,
  choicesForApp,
  DELETION_APPS,
  sendAccountDeleted,
  type AccountDeletedBody,
  type AppOpenAction,
  type AppPreview,
  type DeletionAppEntry,
  type DeletionAppsConfig,
  type KeptItem,
} from "./deletion-apps";
import { jobPredatesRestoreRecord } from "./deletion-job-shape";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 7-day soft-delete grace window. */
const ACCOUNT_DELETION_GRACE_SECONDS = 7 * 24 * 60 * 60;

/** How long an erased account's handles stay held after its hard delete: 30 days. */
const HANDLE_HOLD_AFTER_ERASURE_SECONDS = 30 * 24 * 60 * 60;

/** The window in seconds, for the date a preview tells apps the fan-out will run. */
export const DELETION_WINDOW_SECONDS = ACCOUNT_DELETION_GRACE_SECONDS;

/**
 * An app's mark on a job reads done: a positive time. NULL is pending, and so
 * is `-1`, the "not enrolled" mark a job written before every account went to
 * every app holds; such a job is sent to that app now.
 */
const markDone = (column: AnySQLiteColumn): SQL => sql`coalesce(${column}, 0) > 0`;

/** An app's mark on a job reads pending: NULL or the old `-1`. */
const markPending = (column: AnySQLiteColumn): SQL => sql`coalesce(${column}, 0) <= 0`;

/** Every app's mark reads done. */
const allAppsDone = (): SQL | undefined =>
  and(...DELETION_APPS.map((entry) => markDone(entry.done)));

/** Some app's mark reads pending. */
const someAppPending = (): SQL | undefined =>
  or(...DELETION_APPS.map((entry) => markPending(entry.done)));

/** Whether `mark`, as read, is pending. */
const isPending = (mark: number | null): boolean => mark === null || mark <= 0;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

class AccountErasureDbError extends Data.TaggedError("AccountErasureDbError")<{
  readonly cause: unknown;
}> {}

export class AccountNotFoundError extends Data.TaggedError("AccountNotFoundError")<{
  readonly accountId: string;
}> {}

export class DeletionAlreadyPendingError extends Data.TaggedError("DeletionAlreadyPendingError")<{
  readonly accountId: string;
  readonly scheduledFor: number;
}> {}

/** A deletion job's stored `choices` that cannot be read. */
class ErasureChoicesError extends Data.TaggedError("ErasureChoicesError")<{
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

/** One answer to an open action: `transfer`, `successor` (naming the profile) or `delete`. */
export interface ErasureChoice {
  readonly choice: string;
  readonly successorProfileId?: string;
}

/** The answers a deletion job stores, keyed by action id. */
export type ErasureChoices = Readonly<Record<string, ErasureChoice>>;

interface RequestErasureInput {
  readonly accountId: string;
  /**
   * The requesting session: its hash (recorded on the job) and its family,
   * whose sessions the soft delete spares. The route's live-session check
   * found the session live in this request, so a refresh of it in another tab
   * keeps the device signed in. Null spares nothing.
   */
  readonly cancel: { readonly sessionId: string; readonly familyId: string } | null;
  /** "user_request" | "minor_detected" | "admin". */
  readonly reason?: string;
  /** The `handle_holds` digest (`auth.heldHandleDigest`) the holds are written under. */
  readonly heldHandleDigest: HeldHandleDigest;
  /**
   * The person's answers to the deletion's open actions, as the route checked
   * them ({@link checkErasureChoices}). Stored on the job for the hard delete;
   * none stores NULL.
   */
  readonly choices?: ErasureChoices;
  /**
   * The person chose to delete everything: stored on the job and sent to
   * every app, which erases their data soonest; `choices` is then empty.
   */
  readonly deleteEverything?: boolean;
}

interface RequestErasureOutput {
  readonly accountId: string;
  /** Unix seconds when the account is scheduled for hard delete. */
  readonly scheduledFor: number;
  /** True if this call inserted a new tombstone; false if one already existed. */
  readonly newlyScheduled: boolean;
  /** The account's profiles as this call read them; empty when it scheduled nothing. */
  readonly profileIds: ReadonlyArray<string>;
}

const newId = (prefix: string): string =>
  `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/** A deletion job's `job_id`: random, so no two jobs share one. */
const newJobId = (): string => `djob_${crypto.randomUUID().replace(/-/g, "")}`;

/**
 * The id of the `account_deletion_cancelled` event for one deletion job, from
 * the account and the job's `job_id`: the same for every cancel of that job,
 * so the table's key lets one of them record it, and a different one for
 * every job. A job written before `job_id` existed is named by its
 * `soft_deleted_at` instead. The shape of every event id (`sev_` and 12 hex),
 * which the acknowledge route requires.
 */
const cancelEventId = (accountId: string, job: string | number): string =>
  `sev_${createHash("sha256").update(`${accountId}:${job}`).digest("hex").slice(0, 12)}`;

/** The ids of every profile of `accountId`, for the apps a preview asks. */
export const profileIdsOf = (
  accountId: string,
): Effect.Effect<ReadonlyArray<string>, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () => db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId)),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    return rows.map((row) => row.id);
  });

/** A subquery of the ids of every profile of `accountId`. */
const profilesOf = (db: DbService["db"], accountId: string) =>
  db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId));

/**
 * Each statement in turn, for bun:sqlite, which has no batch; answers their
 * results in order, as a D1 batch does.
 */
const inOrder = (statements: ReadonlyArray<BatchItem<"sqlite">>): Promise<unknown[]> =>
  statements.reduce<Promise<unknown[]>>(
    async (done, statement) => [...(await done), await statement],
    Promise.resolve([]),
  );

/**
 * The hard-delete date of the account's standing deletion, when its job exists
 * and the account is tombstoned; null otherwise.
 */
const standingDeletion = (accountId: string) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ hardDeleteAt: deletionJobs.hardDeleteAt })
          .from(deletionJobs)
          .innerJoin(accounts, eq(accounts.id, deletionJobs.accountId))
          .where(and(eq(deletionJobs.accountId, accountId), sql`${accounts.deletedAt} IS NOT NULL`))
          .limit(1),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    return rows[0]?.hardDeleteAt ?? null;
  });

/** What a redacted profile's handle begins with: `deleted_` and the suffix of its id. */
const redactedPrefix = sql`'deleted_' || replace(${users.id}, 'usr_', '')`;

/**
 * A profile's redacted handle: `deleted_<id suffix>`, or, while another
 * profile already has that (one registered before the prefix was reserved),
 * the same followed by `_` and 8 random hex digits — 29 characters, within
 * the 30 a handle may have. Decided in the statement that writes it.
 */
const redactedHandle = sql`CASE WHEN EXISTS (
    SELECT 1 FROM users other WHERE other.handle = ${redactedPrefix} AND other.id <> ${users.id})
  THEN ${redactedPrefix} || '_' || lower(hex(randomblob(4)))
  ELSE ${redactedPrefix} END`;

/**
 * Soft-deletes the account: writes the deletion job with what a cancel puts
 * back, redacts every profile's handle, display name and avatar, holds each
 * profile's handle, revokes every session but the requesting device's,
 * closes the app enrolments and, last, tombstones the account. Passkeys,
 * recovery codes and authenticators stay until the hard delete, so a person
 * who can still sign in can cancel: a session of a tombstoned account is
 * limited to the deletion status, the data download and the cancel.
 *
 * Returns the standing deletion's date when the account's job exists and the
 * account is tombstoned. When another request's job lands between this one's
 * read and its batch, the batch fails on the job's key and this answers that
 * deletion too, `newlyScheduled: false`; any other failure is the error.
 *
 * The cross-service fan-out runs later, from the sweeper, once the grace
 * window has closed.
 */
export const requestErasure = (
  input: RequestErasureInput,
): Effect.Effect<RequestErasureOutput, AccountNotFoundError | AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const {
      accountId,
      cancel,
      reason = "user_request",
      heldHandleDigest,
      choices,
      deleteEverything = false,
    } = input;
    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);

    // One read: the account (none means it does not exist), its job if any,
    // and each profile's handle (a lone NULL handle: no profiles).
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            deletedAt: accounts.deletedAt,
            hardDeleteAt: deletionJobs.hardDeleteAt,
            profileId: users.id,
            handle: users.handle,
          })
          .from(accounts)
          .leftJoin(deletionJobs, eq(deletionJobs.accountId, accounts.id))
          .leftJoin(users, eq(users.accountId, accounts.id))
          .where(eq(accounts.id, accountId)),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    const account = rows[0];
    if (!account) {
      return yield* Effect.fail(new AccountNotFoundError({ accountId }));
    }
    // A deletion stands only once its job and its tombstone are both written:
    // the tombstone is the batch's last statement. A job alone (bun:sqlite,
    // whose batch runs one statement at a time, can leave one) goes on to the
    // batch, which fails on the job's key and answers the failure.
    if (account.hardDeleteAt !== null && account.deletedAt !== null) {
      return {
        accountId,
        scheduledFor: account.hardDeleteAt,
        newlyScheduled: false,
        profileIds: [],
      };
    }

    // The handles to hold, as digests. A profile made after this read and
    // before the batch is in the restore record (built in SQL below) but has
    // no hold.
    const held = rows.flatMap((row) => (row.handle === null ? [] : [heldHandleDigest(row.handle)]));

    const hardDeleteAt = now + ACCOUNT_DELETION_GRACE_SECONDS;
    // A deletion of everything stores no answers: the apps and the hard
    // delete each apply their soonest-erasing rule instead. The database
    // refuses the pair too.
    const storedChoices =
      !deleteEverything && choices !== undefined && Object.keys(choices).length > 0
        ? JSON.stringify(choices)
        : null;

    // `email_changes` and `security_events` rows stay, as legal-obligation
    // records (Art. 6(1)(c)+(f)), here and at hard delete. Hard delete keeps
    // their `account_id` as it is: neither table has a foreign key to
    // `accounts`, so the account row goes with the audit rows still naming it.
    const statements: BatchItem<"sqlite">[] = [
      // 1. The deletion job, first: a second request's job already standing
      //    stops the batch here, before anything else is written, on either
      //    driver. Its random `job_id` names this job alone. Every app's mark
      //    starts NULL: the fan-out reaches every app for every account.
      //    `restore` is built from the rows this statement reads: each
      //    profile before redaction, and the open enrolments.
      db.insert(deletionJobs).select(
        db
          .select({
            accountId: bound(accountId, deletionJobs.accountId),
            softDeletedAt: bound(now, deletionJobs.softDeletedAt),
            hardDeleteAt: bound(hardDeleteAt, deletionJobs.hardDeleteAt),
            pulseDoneAt: bound(null, deletionJobs.pulseDoneAt),
            zapDoneAt: bound(null, deletionJobs.zapDoneAt),
            cireDoneAt: bound(null, deletionJobs.cireDoneAt),
            reason: bound(reason, deletionJobs.reason),
            cancelSessionId: bound(cancel?.sessionId ?? null, deletionJobs.cancelSessionId),
            restore: sql<string>`json_object(
              'profiles', json((
                SELECT json_group_array(json_object(
                  'id', p.id, 'handle', p.handle,
                  'displayName', p.display_name, 'avatarUrl', p.avatar_url))
                FROM users p WHERE p.account_id = ${accountId})),
              'enrollments', json((
                SELECT json_group_array(e.id)
                FROM app_enrollments e WHERE e.account_id = ${accountId} AND e.left_at IS NULL)))`.as(
              "restore",
            ),
            choices: bound(storedChoices, deletionJobs.choices),
            jobId: bound(newJobId(), deletionJobs.jobId),
            deleteEverything: bound(deleteEverything, deletionJobs.deleteEverything),
          })
          .from(accounts)
          .where(eq(accounts.id, accountId)),
      ),

      // 2. Redact identity on every profile owned by this account: the
      //    handle becomes its redacted form ({@link redactedHandle}), display
      //    name and avatar are nulled.
      //
      //    One bulk UPDATE with a SQL expression, not a statement per
      //    profile, so the batch's statement count stays the same
      //    whatever `accounts.maxProfiles` allows.
      db
        .update(users)
        .set({
          handle: redactedHandle,
          displayName: null,
          avatarUrl: null,
          updatedAt: new Date(),
        })
        .where(eq(users.accountId, accountId)),

      // 3. Hold each handle: no one may take it while the deletion is pending
      //    or for 30 days after the hard delete. A row already standing on one
      //    of these digests is an old hold past its release (a live one would
      //    have refused the handle to this account); it goes first, so the
      //    insert does not meet it on the key. One insert for every handle,
      //    whatever the profile count.
      ...(held.length > 0
        ? [
            db.delete(handleHolds).where(inArray(handleHolds.handle, jsonEachIn(held))),
            db.insert(handleHolds).select(
              db
                .select({
                  handle: sql<string>`held.value`.as("handle"),
                  accountId: bound(accountId, handleHolds.accountId),
                  releaseAt: bound(null, handleHolds.releaseAt),
                  createdAt: bound(now, handleHolds.createdAt),
                })
                .from(sql`json_each(${JSON.stringify(held)}) held`),
            ),
          ]
        : []),

      // 4. Revoke all sessions EXCEPT the requesting device's: its family, as
      //    the route's check found it, so a refresh of that session in
      //    another tab, finished or in flight, does not sign it out. Every
      //    session of a tombstoned account, this one included, mints only
      //    limited access tokens, and the person can sign in again with a
      //    passkey, a recovery code or their email to reach the cancel.
      cancel
        ? db
            .delete(sessions)
            .where(and(eq(sessions.accountId, accountId), ne(sessions.familyId, cancel.familyId)))
        : db.delete(sessions).where(eq(sessions.accountId, accountId)),

      //    And the rotation records of every family just revoked. The
      //    requesting device's family keeps its own, so a replay of a token
      //    rotated out of that chain still revokes it: that is what reuse
      //    detection is for.
      cancel
        ? db
            .delete(rotatedSessions)
            .where(
              and(
                eq(rotatedSessions.accountId, accountId),
                ne(rotatedSessions.familyId, cancel.familyId),
              ),
            )
        : db.delete(rotatedSessions).where(eq(rotatedSessions.accountId, accountId)),

      // 5. Audit event.
      db.insert(securityEvents).values({
        id: newId("sev_"),
        accountId,
        kind: "account_deletion_scheduled",
        createdAt: now,
        acknowledgedAt: null,
      }),

      // 6. Close every active app enrollment (idempotent — the leaveApp
      //    service helper handles a second call as a no-op, but during
      //    full-account delete we know they should all close).
      db
        .update(appEnrollments)
        .set({ leftAt: now })
        .where(and(eq(appEnrollments.accountId, accountId), isNull(appEnrollments.leftAt))),

      // 7. Tombstone the account row, last: a job and a tombstone together
      //    mean every statement before it ran, on either driver.
      db.update(accounts).set({ deletedAt: now }).where(eq(accounts.id, accountId)),
    ];

    const raced = yield* Effect.tryPromise({
      // All-or-nothing on D1; one statement at a time on bun:sqlite, where a
      // statement that fails leaves the ones before it written.
      try: () => commitBatch(db, statements),
      catch: (cause) => new AccountErasureDbError({ cause }),
    }).pipe(
      Effect.as(null),
      // Another request's deletion may have landed since the read above. Its
      // job alone is not enough to answer from: on bun:sqlite this request's
      // own job insert may have run before a later statement failed. The
      // tombstone, written last, says the deletion that job stands for was
      // written whole.
      Effect.catch((error) =>
        standingDeletion(accountId).pipe(
          Effect.flatMap((scheduledFor) =>
            scheduledFor === null ? Effect.fail(error) : Effect.succeed(scheduledFor),
          ),
        ),
      ),
    );
    if (raced !== null) {
      return { accountId, scheduledFor: raced, newlyScheduled: false, profileIds: [] };
    }

    // Side-effect metrics outside the tx so a failed metric never aborts the
    // soft-delete write.
    metricSecurityEventRecorded("account_deletion_scheduled");
    metricSessionSecurityInvalidation("session_revoke_all");
    metricAccountDeletionCompleted("soft", "user");

    return {
      accountId,
      scheduledFor: hardDeleteAt,
      newlyScheduled: true,
      profileIds: rows.flatMap((row) => (row.profileId === null ? [] : [row.profileId])),
    };
  }).pipe(withAccountDeletion("soft"));

/** One field of a profile's entry in a restore record, for the `users` row being updated. */
const restoredField = (record: string, field: "handle" | "displayName" | "avatarUrl"): SQL =>
  sql`(SELECT json_extract(r.value, ${sql.raw(`'$.${field}'`)}) FROM json_each(${record}, '$.profiles') r WHERE json_extract(r.value, '$.id') = ${users.id})`;

/** A second name for `users`, for a statement on `users` that reads other profiles. */
const otherProfile = alias(users, "other_profile");

/** A second name for `app_enrollments`, for a statement on it that reads the account's other rows. */
const otherEnrolment = alias(appEnrollments, "other_enrolment");

/**
 * Cancels the account's pending deletion: removes the deletion job, clears
 * `accounts.deleted_at`, records the cancel, and puts back what the soft
 * delete took from the job's `restore` record — each profile's handle,
 * display name and avatar, the app enrolments it closed — and releases the
 * account's handle holds. The route admits a caller holding a live session
 * of the account and a step-up token for `account_restore`; nothing here
 * checks either again.
 * Idempotent: returns `{ cancelled: false }` when no job exists.
 *
 * Answers `{ cancelled: false }` too once the grace window has passed or a
 * sweep has begun purging the account (`purge_started_at`): the check holds
 * in the delete itself, so a sweep that claims the account between this
 * read and the write refuses the cancel, and one that comes after the write
 * finds no job to purge.
 *
 * A profile is put back only while it still has a redacted handle (either
 * form the soft delete writes) and the handle it had is free in `users` and
 * `organisations`; otherwise it keeps the redacted form. An enrolment is reopened only while it is closed at the soft
 * delete's time and the account has no other open enrolment in that app. A
 * job written before the restore record existed (`restore` NULL) cancels with
 * none of this.
 */
export const cancelErasure = (
  accountId: string,
): Effect.Effect<{ cancelled: boolean }, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const existing = yield* Effect.tryPromise({
      try: () =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)).limit(1),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    if (!existing[0]) return { cancelled: false };

    const now = Math.floor(Date.now() / 1_000);

    // Cancellation is only honoured INSIDE the grace window and before any
    // purge. Once `hardDeleteAt` has passed, the fan-out sweep may already be
    // purging Pulse / Zap data — resurrecting the OSN account at that point
    // would leave it half-erased downstream with no way to re-trigger the
    // purge (the per-account purge ledger treats it as already processed).
    // Checked here to answer the common case with no write, and again in the
    // delete below.
    if (existing[0].hardDeleteAt <= now || existing[0].purgeStartedAt !== null) {
      return { cancelled: false };
    }

    // The job goes first: the job this request read, by its `job_id`, and
    // only while no sweep has claimed it and the window is open. A job written
    // before `job_id` existed is named by its `soft_deleted_at`, and only
    // while the job standing has no `job_id` either, so a cancel of it never
    // removes a newer job. Every later statement runs only once no job stands,
    // and the event only while the account row exists. The event's id is the
    // job's own, so a job's cancellation is recorded once: a second cancel of
    // the same job finds the id taken and writes nothing. So a refused cancel
    // writes nothing, whether a sweep, another cancel or a new request came
    // first.
    const { softDeletedAt, jobId, restore: record } = existing[0];
    const jobGone = notExists(
      db
        .select({ one: sql`1` })
        .from(deletionJobs)
        .where(eq(deletionJobs.accountId, accountId)),
    );
    const release = db
      .delete(deletionJobs)
      .where(
        and(
          eq(deletionJobs.accountId, accountId),
          jobId !== null
            ? eq(deletionJobs.jobId, jobId)
            : and(isNull(deletionJobs.jobId), eq(deletionJobs.softDeletedAt, softDeletedAt)),
          isNull(deletionJobs.purgeStartedAt),
          gt(deletionJobs.hardDeleteAt, now),
        ),
      );
    const restore = db
      .update(accounts)
      .set({ deletedAt: null })
      .where(and(eq(accounts.id, accountId), jobGone));
    const audit = db
      .insert(securityEvents)
      .select(
        db
          .select({
            id: bound(cancelEventId(accountId, jobId ?? softDeletedAt), securityEvents.id),
            accountId: bound(accountId, securityEvents.accountId),
            kind: bound("account_deletion_cancelled", securityEvents.kind),
            createdAt: bound(now, securityEvents.createdAt),
            acknowledgedAt: bound(null, securityEvents.acknowledgedAt),
          })
          .from(accounts)
          .where(and(eq(accounts.id, accountId), jobGone)),
      )
      .onConflictDoNothing({ target: securityEvents.id });

    const putBack: BatchItem<"sqlite">[] = [];
    if (!jobPredatesRestoreRecord(existing[0]) && record !== null) {
      const handle = restoredField(record, "handle");
      putBack.push(
        db
          .update(users)
          .set({
            handle,
            displayName: restoredField(record, "displayName"),
            avatarUrl: restoredField(record, "avatarUrl"),
            updatedAt: new Date(now * 1_000),
          })
          .where(
            and(
              eq(users.accountId, accountId),
              // Redacted: `deleted_<id suffix>`, alone or with the random
              // tail the soft delete adds when another profile had that.
              // `substr`, not LIKE, whose `_` matches any character.
              sql`substr(${users.handle}, 1, length(${redactedPrefix})) = ${redactedPrefix}`,
              sql`${handle} IS NOT NULL`,
              jobGone,
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(otherProfile)
                  .where(eq(otherProfile.handle, handle)),
              ),
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(organisations)
                  .where(eq(organisations.handle, handle)),
              ),
            ),
          ),
        db.delete(handleHolds).where(and(eq(handleHolds.accountId, accountId), jobGone)),
        db
          .update(appEnrollments)
          .set({ leftAt: null })
          .where(
            and(
              eq(appEnrollments.accountId, accountId),
              inArray(
                appEnrollments.id,
                sql`(SELECT value FROM json_each(${record}, '$.enrollments'))`,
              ),
              eq(appEnrollments.leftAt, softDeletedAt),
              jobGone,
              notExists(
                db
                  .select({ one: sql`1` })
                  .from(otherEnrolment)
                  .where(
                    and(
                      eq(otherEnrolment.accountId, appEnrollments.accountId),
                      eq(otherEnrolment.app, appEnrollments.app),
                      isNull(otherEnrolment.leftAt),
                    ),
                  ),
              ),
            ),
          ),
      );
    }

    const released = yield* Effect.tryPromise({
      // One batch on D1; one statement at a time on bun:sqlite.
      try: async () => {
        const [result] = canBatch(db)
          ? await db.batch([release, restore, audit, ...putBack])
          : await inOrder([release, restore, audit, ...putBack]);
        return rowsChanged(result);
      },
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    if (released === 0) return { cancelled: false };
    metricSecurityEventRecorded("account_deletion_cancelled");
    metricAccountDeletionCompleted("cancelled", "user");
    return { cancelled: true };
  });

/**
 * Returns the current deletion status for an account — used by
 * `GET /account/deletion-status`, by `DELETE /account` to answer a deletion
 * already pending, and by `POST /account/restore` to answer one that is not.
 */
export const getDeletionStatus = (
  accountId: string,
): Effect.Effect<
  { scheduled: false } | { scheduled: true; scheduledFor: number; softDeletedAt: number },
  AccountErasureDbError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            hardDeleteAt: deletionJobs.hardDeleteAt,
            softDeletedAt: deletionJobs.softDeletedAt,
          })
          .from(deletionJobs)
          .where(eq(deletionJobs.accountId, accountId))
          .limit(1),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    const row = rows[0];
    if (!row) return { scheduled: false } as const;
    return {
      scheduled: true as const,
      scheduledFor: row.hardDeleteAt,
      softDeletedAt: row.softDeletedAt,
    };
  });

// ---------------------------------------------------------------------------
// Owned organisations — the deletion's open actions
// ---------------------------------------------------------------------------

/** What happens to an owned organisation at the hard delete. */
export type OrganisationChoice = "transfer" | "successor" | "delete";

/** The open action id of an owned organisation. */
const ORGANISATION_ACTION_PREFIX = "osn:organisation:";

export const organisationActionId = (orgId: string): string =>
  `${ORGANISATION_ACTION_PREFIX}${orgId}`;

/** An organisation one of the account's profiles owns, and who would take it over. */
export interface OwnedOrganisation {
  readonly orgId: string;
  readonly handle: string;
  readonly name: string;
  /**
   * The member the hard delete hands it to when no successor is named: the
   * longest-standing admin from another account, else the longest-standing
   * member from another account. Null when no other account's profile is a
   * member.
   */
  readonly successor: {
    readonly profileId: string;
    readonly handle: string;
    readonly displayName: string | null;
    readonly role: "admin" | "member";
  } | null;
}

/** The choices an owned organisation allows: all three with another member, else `delete`. */
export const organisationChoices = (org: OwnedOrganisation): ReadonlyArray<OrganisationChoice> =>
  org.successor === null ? ["delete"] : ["transfer", "successor", "delete"];

/**
 * The choice the hard delete takes for an owned organisation with no answer:
 * `transfer` when another admin can take it over. Null when the person must
 * choose before the deletion is requested.
 */
export const organisationDefaultChoice = (org: OwnedOrganisation): "transfer" | null =>
  org.successor?.role === "admin" ? "transfer" : null;

/**
 * `organisation_members` of `orgId` whose profile belongs to an account other
 * than `accountId`, best successor first: admins before members ('admin'
 * sorts before 'member', the only two roles the triggers allow), then the
 * longest-standing, then by id. That is the order of
 * `org_members_succession_idx`, so the read walks the index and stops at the
 * first member from another account. `column` picks what the subquery answers.
 */
const successorRow = (
  column: "id" | "profile_id",
  orgId: SQL | AnySQLiteColumn,
  accountId: string,
) =>
  sql`(SELECT m.${sql.raw(column)} FROM organisation_members m JOIN users u ON u.id = m.profile_id
    WHERE m.organisation_id = ${orgId} AND u.account_id <> ${accountId}
    ORDER BY m.role, m.created_at, m.id LIMIT 1)`;

/**
 * The profile `orgId` passes to at the hard delete of `accountId`: the
 * successor named for it in `named` (a JSON object of organisation id to
 * profile id) while that profile is still a member from another account, else
 * the best successor ({@link successorRow}). NULL when there is none.
 */
const successorOf = (orgId: SQL | AnySQLiteColumn, accountId: string, named: string): SQL =>
  sql`COALESCE(
    (SELECT m.profile_id FROM organisation_members m JOIN users u ON u.id = m.profile_id
      WHERE m.organisation_id = ${orgId} AND u.account_id <> ${accountId}
        AND m.profile_id = (SELECT n.value FROM json_each(${named}) n WHERE n.key = ${orgId})),
    ${successorRow("profile_id", orgId, accountId)})`;

const successorMember = alias(organisationMembers, "successor_member");
const successorProfile = alias(users, "successor_profile");

/**
 * Every organisation a profile of `accountId` owns, oldest first, with the
 * member it would pass to: the open actions the deletion preview lists and
 * `DELETE /account` checks choices against. One statement, whatever the
 * number of profiles or organisations.
 */
export const listOwnedOrganisations = (
  accountId: string,
): Effect.Effect<ReadonlyArray<OwnedOrganisation>, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            orgId: organisations.id,
            handle: organisations.handle,
            name: organisations.name,
            successorProfileId: successorMember.profileId,
            successorRole: successorMember.role,
            successorHandle: successorProfile.handle,
            successorDisplayName: successorProfile.displayName,
          })
          .from(organisations)
          .leftJoin(
            successorMember,
            eq(successorMember.id, successorRow("id", organisations.id, accountId)),
          )
          .leftJoin(successorProfile, eq(successorProfile.id, successorMember.profileId))
          .where(inArray(organisations.ownerId, profilesOf(db, accountId)))
          .orderBy(asc(organisations.createdAt), asc(organisations.id)),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    return rows.map((row) => ({
      orgId: row.orgId,
      handle: row.handle,
      name: row.name,
      successor:
        row.successorProfileId !== null &&
        row.successorRole !== null &&
        row.successorHandle !== null
          ? {
              profileId: row.successorProfileId,
              handle: row.successorHandle,
              displayName: row.successorDisplayName,
              role: row.successorRole,
            }
          : null,
    }));
  });

/** One answer as `DELETE /account` received it. */
export interface ErasureChoiceAnswer {
  readonly action: string;
  readonly choice: string;
  /** The profile a `successor` answer names; ignored for any other choice. */
  readonly successorProfileId: string | undefined;
}

/** An open action an app answered in the preview, with the app it came from. */
export interface AppAction {
  readonly app: AppPreview["app"];
  readonly action: AppOpenAction;
}

/** What {@link checkErasureChoices} found. */
export type ErasureChoicesCheck =
  | { readonly kind: "ok"; readonly choices: ErasureChoices }
  /** An answer that names an action of the account and is not one of its choices. */
  | { readonly kind: "invalid"; readonly action: string }
  /**
   * An answer to an app action the fresh preview does not list: the preview
   * changed under the person, and their answer would be lost.
   */
  | { readonly kind: "stale" }
  /** Actions with choices, no default and no answer: the person must choose. */
  | {
      readonly kind: "open";
      readonly organisations: ReadonlyArray<OwnedOrganisation>;
      readonly appActions: ReadonlyArray<AppAction>;
    };

/** The app an answer's action id belongs to, if it is an app's. */
const appOfAction = (action: string): AppPreview["app"] | null =>
  DELETION_APPS.find((entry) => action.startsWith(`${entry.app}:`))?.app ?? null;

/**
 * Checks the answers to a deletion's open actions against the organisations
 * the account owns ({@link listOwnedOrganisations}) and the actions each app
 * answered in a fresh preview. An action id starting `osn:organisation:` is an
 * organisation's, one starting `<app>:` for an app the deletion reaches is
 * that app's, and any other is ignored, as is an organisation the account does
 * not own.
 *
 * In order: an answer is refused (`invalid`) when its action is answered
 * twice, its choice is not one the action offers, or it names a successor who
 * is not a member of that organisation from another account (one read, for
 * every named successor at once); then an answer to an app action the fresh
 * preview does not list makes the whole set `stale`; then every action with
 * choices and no default must have an answer (`open`). On success answers the
 * choices to store, keyed by action id.
 */
export const checkErasureChoices = (
  accountId: string,
  owned: ReadonlyArray<OwnedOrganisation>,
  apps: ReadonlyArray<AppPreview>,
  answers: ReadonlyArray<ErasureChoiceAnswer>,
): Effect.Effect<ErasureChoicesCheck, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const byAction = new Map(owned.map((org) => [organisationActionId(org.orgId), org]));
    const appActions: AppAction[] = apps.flatMap((preview) =>
      preview.status === "checked"
        ? preview.actions.map((action) => ({ app: preview.app, action }))
        : [],
    );
    const byAppAction = new Map(appActions.map((entry) => [entry.action.id, entry.action]));
    const chosen = new Map<string, ErasureChoice>();
    const named: Array<{ action: string; orgId: string; profileId: string }> = [];
    let stale = false;
    for (const answer of answers) {
      if (chosen.has(answer.action)) return { kind: "invalid", action: answer.action } as const;
      const org = byAction.get(answer.action);
      if (org) {
        const allowed = organisationChoices(org) as ReadonlyArray<string>;
        if (!allowed.includes(answer.choice)) {
          return { kind: "invalid", action: answer.action } as const;
        }
        if (answer.choice === "successor") {
          if (answer.successorProfileId === undefined) {
            return { kind: "invalid", action: answer.action } as const;
          }
          named.push({
            action: answer.action,
            orgId: org.orgId,
            profileId: answer.successorProfileId,
          });
          chosen.set(answer.action, {
            choice: answer.choice,
            successorProfileId: answer.successorProfileId,
          });
        } else {
          chosen.set(answer.action, { choice: answer.choice });
        }
        continue;
      }
      if (appOfAction(answer.action) === null) continue;
      const action = byAppAction.get(answer.action);
      if (!action) {
        stale = true;
        continue;
      }
      if (!action.choices.some((choice) => choice.choice === answer.choice)) {
        return { kind: "invalid", action: answer.action } as const;
      }
      chosen.set(answer.action, { choice: answer.choice });
    }

    if (named.length > 0) {
      const { db } = yield* Db;
      const members = yield* Effect.tryPromise({
        try: () =>
          db
            .select({
              orgId: organisationMembers.organisationId,
              profileId: organisationMembers.profileId,
            })
            .from(organisationMembers)
            .innerJoin(users, eq(users.id, organisationMembers.profileId))
            .where(
              and(
                ne(users.accountId, accountId),
                inArray(organisationMembers.organisationId, jsonEachIn(named.map((n) => n.orgId))),
                inArray(organisationMembers.profileId, jsonEachIn(named.map((n) => n.profileId))),
              ),
            ),
        catch: (cause) => new AccountErasureDbError({ cause }),
      });
      const isMember = new Set(members.map((m) => `${m.orgId} ${m.profileId}`));
      const stranger = named.find((n) => !isMember.has(`${n.orgId} ${n.profileId}`));
      if (stranger) return { kind: "invalid", action: stranger.action } as const;
    }

    if (stale) return { kind: "stale" } as const;

    const openOrganisations = owned.filter(
      (org) =>
        organisationDefaultChoice(org) === null && !chosen.has(organisationActionId(org.orgId)),
    );
    const openAppActions = appActions.filter(
      ({ action }) =>
        action.choices.length > 0 && action.defaultChoice === null && !chosen.has(action.id),
    );
    if (openOrganisations.length > 0 || openAppActions.length > 0) {
      return {
        kind: "open",
        organisations: openOrganisations,
        appActions: openAppActions,
      } as const;
    }
    return { kind: "ok", choices: Object.fromEntries(chosen) } as const;
  });

// ---------------------------------------------------------------------------
// Cross-service fan-out
// ---------------------------------------------------------------------------

/** A stored `choices` value that cannot be read: the fan-out of that job fails until it is fixed. */
class StoredChoicesUnreadable extends Data.TaggedError("StoredChoicesUnreadable")<{
  readonly cause: unknown;
}> {}

/** Each stored answer's choice, by action id; anything else in the record is left out. */
const storedAnswers = (
  stored: string | null,
): Effect.Effect<Record<string, { readonly choice: string }>, StoredChoicesUnreadable> =>
  Effect.try({
    try: () => {
      if (stored === null) return {};
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("stored choices are not an object");
      }
      const answers: Record<string, { readonly choice: string }> = {};
      for (const [action, answer] of Object.entries(parsed)) {
        const choice = (answer as { readonly choice?: unknown } | null)?.choice;
        if (typeof choice === "string") answers[action] = { choice };
      }
      return answers;
    },
    catch: (cause) => new StoredChoicesUnreadable({ cause }),
  });

/** What every app is sent about one job, before its own choices are picked out. */
interface FanOutJobBody {
  readonly accountId: string;
  readonly profileIds: ReadonlyArray<string>;
  readonly answers: Readonly<Record<string, { readonly choice: string }>>;
  readonly deleteEverything: boolean;
}

/** The profile ids the fan-out read holds as a JSON array; anything else fails the job. */
const readProfileIds = (
  stored: string,
): Effect.Effect<ReadonlyArray<string>, AccountErasureDbError> =>
  Effect.try({
    try: () => {
      const parsed: unknown = JSON.parse(stored);
      if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
        throw new TypeError("profile ids are not an array of strings");
      }
      return parsed as ReadonlyArray<string>;
    },
    catch: (cause) => new AccountErasureDbError({ cause }),
  });

/** The JSON path of `app`'s entry in `app_outcomes`. */
const outcomePath = (app: DeletionAppEntry["app"]): string => `$.${app}`;

/** `{ "status": "skipped" }`, as `app_outcomes` records an app the tier does not run. */
const SKIPPED_OUTCOME = JSON.stringify({ status: "skipped" });

/**
 * Marks the fan-out done with `entry`'s app and records what it reported, in
 * one statement, only while the mark still reads pending: a mark already set
 * is never overwritten, and neither is that app's outcome. Answers whether
 * this call wrote the mark.
 */
const markAppDone = (
  entry: DeletionAppEntry,
  accountId: string,
  outcome:
    | { readonly status: "done"; readonly kept: ReadonlyArray<KeptItem> }
    | { readonly status: "skipped" },
): Effect.Effect<boolean, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);
    const values: SQLiteUpdateSetSource<typeof deletionJobs> = {
      appOutcomes: sql`json_set(coalesce(${deletionJobs.appOutcomes}, '{}'), ${outcomePath(entry.app)}, json(${JSON.stringify(outcome)}))`,
    };
    values[entry.doneKey] = now;
    const marked = yield* Effect.tryPromise({
      try: () =>
        db
          .update(deletionJobs)
          .set(values)
          .where(and(eq(deletionJobs.accountId, accountId), markPending(entry.done))),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    return rowsChanged(marked) === 1;
  });

/** Stamps the job's `fanout_failed_at`, so the next pass reads it after every job that has not failed. */
const stampFanOutFailure = (accountId: string, nowSec: number): Effect.Effect<void, never, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(deletionJobs)
          .set({ fanoutFailedAt: nowSec })
          .where(eq(deletionJobs.accountId, accountId)),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError(
        "account.deletion fan-out failure not recorded",
        safeErrorSummary(Cause.squash(cause)),
      ),
    ),
  );

/**
 * Marks the account's purge as begun, before a sweep purges anything, and
 * answers whether the sweep may go on: true when this call wrote the mark —
 * the job still exists, no other sweep has marked it, and its grace window
 * has passed by `nowSec`. A cancel that comes after is refused; one that came
 * before has removed the job, and this answers false.
 *
 * For the hard delete (`appsDone`), the mark is written only while every
 * app's mark reads done. For the fan-out, each app in `skipped` (one the tier
 * does not run) is marked done, its outcome `skipped`, in the same statement:
 * no fan-out has written a mark on a job not yet claimed.
 */
const claimPurge = (
  accountId: string,
  nowSec: number,
  {
    appsDone = false,
    skipped = [],
  }: { readonly appsDone?: boolean; readonly skipped?: ReadonlyArray<DeletionAppEntry> } = {},
): Effect.Effect<boolean, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const values: SQLiteUpdateSetSource<typeof deletionJobs> = { purgeStartedAt: nowSec };
    if (skipped.length > 0) {
      values.appOutcomes = sql`json_set(coalesce(${deletionJobs.appOutcomes}, '{}'), ${sql.join(
        skipped.map((entry) => sql`${outcomePath(entry.app)}, json(${SKIPPED_OUTCOME})`),
        sql`, `,
      )})`;
      for (const entry of skipped) values[entry.doneKey] = nowSec;
    }
    const claimed = yield* Effect.tryPromise({
      try: () =>
        db
          .update(deletionJobs)
          .set(values)
          .where(
            and(
              eq(deletionJobs.accountId, accountId),
              isNull(deletionJobs.purgeStartedAt),
              lte(deletionJobs.hardDeleteAt, nowSec),
              appsDone ? allAppsDone() : undefined,
            ),
          ),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    return rowsChanged(claimed) === 1;
  });

/** Counts and logs an app the fan-out marked skipped. */
const recordSkipped = (entry: DeletionAppEntry): Effect.Effect<void> =>
  Effect.suspend(() => {
    metricAccountDeletionFanout(entry.app, "skipped");
    return Effect.logInfo("account.deletion fan-out skipped an app this tier does not run", {
      app: entry.app,
    });
  });

/**
 * Finishes the fan-out with one app: skipped where the tier does not run it,
 * sent and recorded where it does. Answers whether the app is finished; a
 * failure is counted and logged, with no ids, and the mark stays pending.
 * The result is counted only when this call wrote the mark: a mark another
 * pass wrote first, or a job gone since, counts nothing.
 */
const finishApp = (
  config: DeletionAppsConfig,
  entry: DeletionAppEntry,
  body: FanOutJobBody,
): Effect.Effect<boolean, never, Db> => {
  const target = appTarget(config, entry.app);
  const failed = (reason: string, cause: unknown) =>
    Effect.logWarning("account.deletion fan-out to an app failed", {
      app: entry.app,
      reason,
      ...safeErrorSummary(cause),
    }).pipe(Effect.as(false));
  if (target.kind === "unconfigured") {
    metricAccountDeletionFanout(entry.app, "error");
    return Effect.logError("account.deletion app has no URL on a deployed tier", {
      app: entry.app,
    }).pipe(Effect.as(false));
  }
  if (target.kind === "skip") {
    return markAppDone(entry, body.accountId, { status: "skipped" }).pipe(
      Effect.tap((marked) => (marked ? recordSkipped(entry) : Effect.void)),
      Effect.as(true),
      Effect.catch((cause) => failed("mark_failed", cause)),
    );
  }
  const sent: AccountDeletedBody = {
    accountId: body.accountId,
    profileIds: body.profileIds,
    choices: choicesForApp(entry.app, body.answers),
    deleteEverything: body.deleteEverything,
  };
  return sendAccountDeleted(config, entry, target.url, sent).pipe(
    Effect.tapError((error) =>
      Effect.sync(() => metricAccountDeletionFanout(entry.app, error.result)),
    ),
    Effect.flatMap((kept) => markAppDone(entry, body.accountId, { status: "done", kept })),
    Effect.tap((marked) =>
      Effect.sync(() => {
        if (marked) metricAccountDeletionFanout(entry.app, "ok");
      }),
    ),
    Effect.as(true),
    Effect.catch((cause) => failed("not_finished", cause)),
  );
};

/** A job as the fan-out reads it: its marks, its claim, and what every app is sent. */
interface FanOutJob extends Pick<
  DeletionJob,
  | "accountId"
  | "pulseDoneAt"
  | "zapDoneAt"
  | "cireDoneAt"
  | "purgeStartedAt"
  | "choices"
  | "deleteEverything"
> {
  /** The account's profile ids, a JSON array. */
  readonly profileIds: string;
}

const markOf = (job: FanOutJob, entry: DeletionAppEntry): number | null => job[entry.doneKey];

/**
 * Runs the fan-out for one job: every app whose mark reads pending, all at
 * once. A job the sweep read unclaimed is claimed first ({@link claimPurge}),
 * at `nowSec`, the sweep's clock, and the claim marks each app the tier does
 * not run as skipped; if the claim answers false (a cancel landed since the
 * sweep read the job) nothing is sent. A job already claimed by an earlier
 * pass is not claimed again. When any app is not finished, the job's
 * `fanout_failed_at` is stamped and the next pass tries that app again.
 */
const runFanOut = (
  job: FanOutJob,
  config: DeletionAppsConfig,
  nowSec: number,
): Effect.Effect<void, AccountErasureDbError | StoredChoicesUnreadable, Db> =>
  Effect.gen(function* () {
    const body: FanOutJobBody = {
      accountId: job.accountId,
      profileIds: yield* readProfileIds(job.profileIds),
      answers: yield* storedAnswers(job.choices),
      deleteEverything: job.deleteEverything,
    };
    let pending = DELETION_APPS.filter((entry) => isPending(markOf(job, entry)));
    if (job.purgeStartedAt === null) {
      const skipped = pending.filter((entry) => appTarget(config, entry.app).kind === "skip");
      if (!(yield* claimPurge(job.accountId, nowSec, { skipped }))) return;
      yield* Effect.forEach(skipped, recordSkipped, { discard: true });
      pending = pending.filter((entry) => !skipped.includes(entry));
    }
    const finished = yield* Effect.all(
      pending.map((entry) => finishApp(config, entry, body)),
      { concurrency: "unbounded" },
    );
    if (finished.some((done) => !done)) yield* stampFanOutFailure(job.accountId, nowSec);
  });

// ---------------------------------------------------------------------------
// Hard-delete sweeper
// ---------------------------------------------------------------------------

/** What a hard delete did. */
export interface HardDeleteResult {
  /** False when a cancel landed first and nothing was deleted. */
  readonly deleted: boolean;
  /** Each owned organisation passed to another member, and its new owner. */
  readonly transfers: ReadonlyArray<{ readonly orgId: string; readonly ownerProfileId: string }>;
  /** How many owned organisations were deleted. */
  readonly orgsDeleted: number;
}

const NOTHING_DELETED: HardDeleteResult = { deleted: false, transfers: [], orgsDeleted: 0 };

/**
 * A job's stored `choices`, as the hard delete uses them: each named
 * successor by organisation id, and each organisation to delete. `transfer`
 * needs nothing: it is what happens with no answer. An action id that is not
 * an organisation's is ignored; anything else unreadable fails, as a failure
 * of this account alone.
 */
const readStoredChoices = (stored: string | null) =>
  Effect.try({
    try: () => {
      const named = new Map<string, string>();
      const deletes: string[] = [];
      if (stored === null) return { named, deletes };
      const parsed: unknown = JSON.parse(stored);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        throw new TypeError("stored choices are not an object");
      }
      for (const [action, answer] of Object.entries(parsed)) {
        if (!action.startsWith(ORGANISATION_ACTION_PREFIX)) continue;
        const orgId = action.slice(ORGANISATION_ACTION_PREFIX.length);
        const { choice, successorProfileId } = (answer ?? {}) as {
          readonly choice?: unknown;
          readonly successorProfileId?: unknown;
        };
        if (choice === "delete") deletes.push(orgId);
        else if (choice === "successor" && typeof successorProfileId === "string") {
          named.set(orgId, successorProfileId);
        } else if (choice !== "transfer") {
          throw new TypeError("a stored choice is not one the hard delete knows");
        }
      }
      return { named, deletes };
    },
    catch: (cause) => new ErasureChoicesError({ cause }),
  });

/** A log-safe summary of why an account's hard delete failed: the error's tag, never ids. */
const failureSummary = (cause: Cause.Cause<unknown>) => ({
  defect: Cause.hasDies(cause),
  ...safeErrorSummary(Cause.squash(cause)),
});

/**
 * After a hard delete fails: logs it with no ids, counts it, and stamps the
 * job's `hard_delete_failed_at`, so the next pass reads it after every job
 * that has not failed. A failed stamp is logged and changes nothing else.
 */
const recordHardDeleteFailure = (accountId: string, nowSec: number, cause: Cause.Cause<unknown>) =>
  Effect.gen(function* () {
    yield* Effect.logError("account.deletion hard delete failed", failureSummary(cause));
    metricAccountDeletionCompleted("hard_failed", "sweeper");
    const { db } = yield* Db;
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(deletionJobs)
          .set({ hardDeleteFailedAt: nowSec })
          .where(eq(deletionJobs.accountId, accountId)),
      catch: (stampCause) => new AccountErasureDbError({ cause: stampCause }),
    }).pipe(
      Effect.catchCause((stampCause) =>
        Effect.logError(
          "account.deletion hard delete failure not recorded",
          failureSummary(stampCause),
        ),
      ),
    );
  });

/**
 * How many hard deletes in a row may fail before a pass stops: past that the
 * cause is more likely the database (an outage, or the Worker's per-invocation
 * query cap) than the accounts, and each further attempt would spend calls
 * and count a failure no account caused.
 */
const HARD_DELETE_FAILURES_BEFORE_STOP = 3;

/**
 * Single sweeper pass. Hard-deletes, at most `batchSize` of them, every
 * account whose deletion_jobs row has crossed `hard_delete_at` AND whose every
 * app mark reads done. Returns the count of hard-deletes performed.
 *
 * Reads jobs that have never failed first, then the least recently failed,
 * each group by `hard_delete_at`. One account's failure, a defect included,
 * is logged, counted and stamped on its job, and the pass goes on to the
 * next account, until {@link HARD_DELETE_FAILURES_BEFORE_STOP} fail in a
 * row: the pass then stops, logs that once, and leaves the rest to the next.
 *
 * Runs every 6 h: from the Worker's cron `scheduled` handler when deployed,
 * and from a `setInterval` in the Bun dev server. Safe to run concurrently —
 * each account is processed in its own batch, after its own claim.
 */
export const runHardDeleteSweep = (
  opts: { batchSize?: number; nowMs?: number } = {},
): Effect.Effect<{ purged: number }, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const batchSize = opts.batchSize ?? 100;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1_000);

    // The gating predicate is in SQL, not a filter after the read: a handful
    // of permanently-stuck apps (a pending mark) would otherwise fill the
    // batch and starve the rows whose fan-out is complete. SQLite uses the
    // `deletion_jobs_hard_delete_idx` for `hard_delete_at` and checks the
    // marks row by row; the candidate set is only in-flight deletions.
    const ready = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            accountId: deletionJobs.accountId,
            purgeStartedAt: deletionJobs.purgeStartedAt,
            choices: deletionJobs.choices,
          })
          .from(deletionJobs)
          .where(and(lte(deletionJobs.hardDeleteAt, nowSec), allAppsDone()))
          .orderBy(
            sql`${deletionJobs.hardDeleteFailedAt} ASC NULLS FIRST`,
            asc(deletionJobs.hardDeleteAt),
          )
          .limit(batchSize),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });

    let purged = 0;
    let failedInARow = 0;
    for (const row of ready) {
      if (failedInARow === HARD_DELETE_FAILURES_BEFORE_STOP) {
        yield* Effect.logWarning("account.deletion hard delete sweep stopped", {
          failedInARow,
        });
        break;
      }
      const outcome = yield* hardDeleteAccount(row, nowSec).pipe(
        Effect.map((done) => ({ failed: false, done })),
        Effect.catchCause((cause) =>
          recordHardDeleteFailure(row.accountId, nowSec, cause).pipe(
            Effect.as({ failed: true, done: NOTHING_DELETED }),
          ),
        ),
      );
      failedInARow = outcome.failed ? failedInARow + 1 : 0;
      if (!outcome.done.deleted) continue;
      metricAccountDeletionCompleted("hard", "sweeper");
      if (outcome.done.transfers.length > 0) {
        metricAccountDeletionOrganisation("transferred", outcome.done.transfers.length);
      }
      if (outcome.done.orgsDeleted > 0)
        metricAccountDeletionOrganisation("deleted", outcome.done.orgsDeleted);
      purged += 1;
    }
    return { purged };
  }).pipe(withAccountDeletion("hard"));

/**
 * Removes all PII-bearing rows referencing this account, then the account
 * itself, in one batch, and answers what it did. Audit rows in
 * `security_events` and `email_changes` are intentionally preserved, under
 * GDPR Art. 6(1)(c)+(f) (12 mo / 90 d windows defined in
 * `wiki/compliance/retention.md`).
 *
 * A job the sweep read unclaimed is claimed first ({@link claimPurge}), at
 * `nowSec`, the sweep's clock; if a cancel landed since the sweep read it,
 * the claim answers false and nothing is deleted. Nothing else is read
 * before the batch: every statement names the account's profiles by a
 * subquery on the account id, so the statement count and the bound
 * parameters are the same whatever the profile count.
 *
 * Each organisation a profile of the account owns passes, inside the batch,
 * to the successor named in the job's `choices` while that profile is still
 * a member from another account, else to the longest-standing admin from
 * another account, else to the longest-standing member from another account,
 * who is made admin; an organisation with no such member, or with a `delete`
 * choice, is deleted with its memberships. The account's own other profiles
 * are never chosen.
 *
 * Neither audit table has a foreign key to `accounts` (each outlives its
 * parent by design), so the surviving rows stay queryable by accountId. The
 * `users.handle` was redacted to `deleted_<id>` at soft-delete time, so the
 * surviving accountId names no person. The account's handle holds lose
 * their account and are released 30 days on.
 */
export const hardDeleteAccount = (
  job: Pick<DeletionJob, "accountId" | "purgeStartedAt" | "choices">,
  nowSec: number,
): Effect.Effect<HardDeleteResult, AccountErasureDbError | ErasureChoicesError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const { accountId } = job;
    const { named, deletes } = yield* readStoredChoices(job.choices);
    if (
      job.purgeStartedAt === null &&
      !(yield* claimPurge(accountId, nowSec, { appsDone: true }))
    ) {
      return NOTHING_DELETED;
    }

    const profiles = profilesOf(db, accountId);
    const namedJson = JSON.stringify(Object.fromEntries(named));
    const kept = notInArray(organisations.id, jsonEachIn(deletes));

    // 1. The successor of each organisation that will pass on becomes an
    //    admin, if a member. The same rule as the transfer below, read before
    //    either writes: an admin stays an admin, so both agree.
    const promote = db
      .update(organisationMembers)
      .set({ role: "admin" })
      .where(
        and(
          eq(organisationMembers.role, "member"),
          sql`(${organisationMembers.organisationId}, ${organisationMembers.profileId}) IN (
            SELECT o.id, ${successorOf(sql`o.id`, accountId, namedJson)}
            FROM organisations o
            WHERE o.owner_id IN (SELECT p.id FROM users p WHERE p.account_id = ${accountId})
              AND o.id NOT IN ${jsonEachIn(deletes)})`,
        ),
      );
    // 2. Each organisation that has a successor passes to it.
    const transfer = db
      .update(organisations)
      .set({
        ownerId: successorOf(organisations.id, accountId, namedJson),
        updatedAt: new Date(nowSec * 1_000),
      })
      .where(
        and(
          inArray(organisations.ownerId, profiles),
          kept,
          sql`${successorOf(organisations.id, accountId, namedJson)} IS NOT NULL`,
        ),
      )
      .returning({ orgId: organisations.id, ownerProfileId: organisations.ownerId });
    // 3, 4. Every organisation still owned goes, its memberships first.
    const stillOwned = db
      .select({ id: organisations.id })
      .from(organisations)
      .where(inArray(organisations.ownerId, profiles));
    const dropMemberships = db
      .delete(organisationMembers)
      .where(inArray(organisationMembers.organisationId, stillOwned));
    const dropOrganisations = db
      .delete(organisations)
      .where(inArray(organisations.ownerId, profiles))
      .returning({ id: organisations.id });

    // Profile-scoped child rows (FK order), then the profiles, then
    // account-scoped rows, with the `accounts` row deleted LAST.
    const rest: BatchItem<"sqlite">[] = [
      // 5. The graph, the account's memberships in organisations it does not
      //    own, and its OIDC provider records (Art. 17). `oauth_consents`
      //    names every relying party the user linked;
      //    `oauth_authorization_codes` is a live grant in flight, and a
      //    deletion mid-flow takes it too. Both carry a `profile_id`
      //    referencing `users.id`, so they go before the profiles.
      db
        .delete(connections)
        .where(
          or(
            inArray(connections.requesterId, profiles),
            inArray(connections.addresseeId, profiles),
          ),
        ),
      db
        .delete(blocks)
        .where(or(inArray(blocks.blockerId, profiles), inArray(blocks.blockedId, profiles))),
      db.delete(organisationMembers).where(inArray(organisationMembers.profileId, profiles)),
      db.delete(oauthConsents).where(eq(oauthConsents.accountId, accountId)),
      db.delete(oauthAuthorizationCodes).where(eq(oauthAuthorizationCodes.accountId, accountId)),
      // 6. The profiles, then the account's sessions, rotation records and
      //    credentials. Each references the account, so one left behind
      //    fails the batch on the foreign key.
      db.delete(users).where(eq(users.accountId, accountId)),
      db.delete(sessions).where(eq(sessions.accountId, accountId)),
      db.delete(rotatedSessions).where(eq(rotatedSessions.accountId, accountId)),
      db.delete(passkeys).where(eq(passkeys.accountId, accountId)),
      db.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId)),
      db.delete(totpCredentials).where(eq(totpCredentials.accountId, accountId)),
      // 7. The app enrolments, open and closed: they name the account.
      db.delete(appEnrollments).where(eq(appEnrollments.accountId, accountId)),
      // 8. The handle holds outlive the account by 30 days, keyed by digest
      //    alone.
      db
        .update(handleHolds)
        .set({ accountId: null, releaseAt: nowSec + HANDLE_HOLD_AFTER_ERASURE_SECONDS })
        .where(eq(handleHolds.accountId, accountId)),
      // 9. The job, the clients the account registered, the account. The
      //    job goes only while every app's mark still reads done; otherwise
      //    it stays, the `accounts` delete below fails on the job's foreign
      //    key, and D1 rolls the whole batch back, so the fan-out reaches
      //    every app before the account is erased.
      db.delete(deletionJobs).where(and(eq(deletionJobs.accountId, accountId), allAppsDone())),
      // Clients the account REGISTERED (owner side): disable them and
      // sever the ownership link. The rows themselves stay — other users'
      // consents reference them by client_id, and once unlinked they hold
      // no personal data — but a client whose steward is gone must stop
      // authorising (disabled reads as absent everywhere).
      db
        .update(oauthClients)
        .set({ disabledAt: Math.floor(Date.now() / 1_000), ownerAccountId: null })
        .where(eq(oauthClients.ownerAccountId, accountId)),
      // Kept on purpose, as security records (Art. 6(1)(c)+(f)), for the
      // retention window wiki/compliance/retention.md sets for each:
      //   - security_events   — 12 months
      //   - email_changes     — 90 days
      // Both retain the now-orphaned `account_id`. PII linkage is broken
      // because `users.handle` was redacted at soft-delete and the
      // `accounts.email` row is gone here.
      db.delete(accounts).where(eq(accounts.id, accountId)),
    ];

    const { transfers, dropped } = yield* Effect.tryPromise({
      // Atomic batch on D1; one statement at a time on bun:sqlite. Either
      // way the transfer's and the organisation delete's RETURNING rows come
      // back.
      try: async () => {
        if (canBatch(db)) {
          const [, moved, , gone] = await db.batch([
            promote,
            transfer,
            dropMemberships,
            dropOrganisations,
            ...rest,
          ]);
          return { transfers: moved, dropped: gone.length };
        }
        await promote;
        const moved = await transfer;
        await dropMemberships;
        const gone = await dropOrganisations;
        await inOrder(rest);
        return { transfers: moved, dropped: gone.length };
      },
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    return { deleted: true, transfers, orgsDeleted: dropped };
  });

/** Jobs one fan-out pass reaches, and accounts one hard-delete pass erases, by default. */
export const DELETION_SWEEP_DEFAULT_MAX_JOBS = 4;

/**
 * The per-run job cap from `OSN_DELETION_FANOUT_MAX_JOBS`: the default when
 * unset, `"invalid"` (and the caller uses the default) when not a whole number
 * from 1 to 200. The default fits one cron run inside Workers Free's 50 D1
 * queries with every other sweep at its cap (`wiki/shared/free-tier-limits.md`).
 */
export const deletionSweepMaxJobs = (raw: string | undefined): number | "invalid" => {
  if (raw === undefined || raw.trim() === "") return DELETION_SWEEP_DEFAULT_MAX_JOBS;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 200 ? parsed : "invalid";
};

/** An app's oldest unfinished job past this age is logged as overdue. */
const FANOUT_OVERDUE_SECONDS = 86_400;

/**
 * Records, for each app, how long ago its oldest unfinished job became due
 * (0 when it has none), and logs an app whose oldest is more than a day old.
 * One read over every due job.
 */
const recordOldestPending = (nowSec: number): Effect.Effect<void, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select(
            Object.fromEntries(
              DELETION_APPS.map((entry) => [
                entry.app,
                sql<
                  number | null
                >`min(CASE WHEN ${markPending(entry.done)} THEN ${deletionJobs.hardDeleteAt} END)`,
              ]),
            ),
          )
          .from(deletionJobs)
          .where(lte(deletionJobs.hardDeleteAt, nowSec)),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    const oldest = rows[0] ?? {};
    for (const entry of DELETION_APPS) {
      const due = oldest[entry.app];
      const age = typeof due === "number" ? Math.max(0, nowSec - due) : 0;
      metricAccountDeletionFanoutOldestAge(entry.app, age);
      if (age > FANOUT_OVERDUE_SECONDS) {
        yield* Effect.logWarning("account.deletion fan-out overdue", {
          app: entry.app,
          ageSeconds: age,
        });
      }
    }
  });

/**
 * Fan-out sweeper pass, the only thing that reaches the apps for an erasure.
 *
 * Reads at most `maxJobs` jobs whose window has passed and whose mark for some
 * app reads pending (NULL, or `-1` on a job written before every account went
 * to every app): never-failed jobs first, then the least recently failed,
 * each group by `hard_delete_at`, so a job an app keeps failing never stands
 * in front of the rest. Each job's pending apps are called at once; an app
 * that does not finish leaves its mark pending for the next pass. Records the
 * age of each app's oldest unfinished job (§6 of the deletion design).
 *
 * Apps are reached only once the window has passed: erasing app data at the
 * soft delete would destroy what a cancel promises to give back.
 */
export const runFanOutRetrySweep = (opts: {
  readonly config: DeletionAppsConfig;
  readonly maxJobs?: number;
  readonly nowMs?: number;
}): Effect.Effect<{ retried: number }, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const maxJobs = opts.maxJobs ?? DELETION_SWEEP_DEFAULT_MAX_JOBS;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1_000);

    const [pending] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: (): Promise<FanOutJob[]> =>
            db
              .select({
                accountId: deletionJobs.accountId,
                pulseDoneAt: deletionJobs.pulseDoneAt,
                zapDoneAt: deletionJobs.zapDoneAt,
                cireDoneAt: deletionJobs.cireDoneAt,
                purgeStartedAt: deletionJobs.purgeStartedAt,
                choices: deletionJobs.choices,
                deleteEverything: deletionJobs.deleteEverything,
                profileIds: sql<string>`(SELECT json_group_array(p.id) FROM users p WHERE p.account_id = ${deletionJobs.accountId})`,
              })
              .from(deletionJobs)
              .innerJoin(accounts, eq(accounts.id, deletionJobs.accountId))
              .where(and(lte(deletionJobs.hardDeleteAt, nowSec), someAppPending()))
              .orderBy(
                sql`${deletionJobs.fanoutFailedAt} ASC NULLS FIRST`,
                asc(deletionJobs.hardDeleteAt),
              )
              .limit(maxJobs),
          catch: (cause) => new AccountErasureDbError({ cause }),
        }),
        recordOldestPending(nowSec),
      ],
      { concurrency: "unbounded" },
    );

    // Each job's failure, a defect included, is logged with no ids and
    // stamped on its job, so the next pass reads it after every job that has
    // not failed; the next job still runs.
    yield* Effect.forEach(
      pending,
      (job) =>
        runFanOut(job, opts.config, nowSec).pipe(
          Effect.catchCause((cause) =>
            Effect.logError("account.deletion fan-out of a job failed", failureSummary(cause)).pipe(
              Effect.andThen(stampFanOutFailure(job.accountId, nowSec)),
            ),
          ),
        ),
      { concurrency: 4, discard: true },
    );
    return { retried: pending.length };
  });

// ---------------------------------------------------------------------------
// External callback — Pulse / Zap notify osn-api that "leave-app" is done
// ---------------------------------------------------------------------------

/**
 * Marks an account's enrollment as left from the app side. Called via the
 * ARC-gated `/internal/app-enrollment/leave` endpoint after Pulse / Zap
 * commits its local soft-delete. Idempotent — wraps `leaveApp`.
 */
export const recordAppEnrollmentLeft = (
  accountId: string,
  app: AppEnrollmentApp,
): Effect.Effect<{ closed: boolean }, AccountErasureDbError, Db> =>
  leaveApp(accountId, app).pipe(Effect.mapError((e) => new AccountErasureDbError({ cause: e })));
