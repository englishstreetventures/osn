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
import type { AppEnrollmentApp, DeletionFanoutService } from "@shared/observability/metrics";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
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
import { alias, type AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { Cause, Data, Effect } from "effect";

import { canBatch } from "../lib/batch";
import { bound } from "../lib/bound";
import type { HeldHandleDigest } from "../lib/handle-hold";
import { arcPostJsonEffect } from "../lib/outbound-arc";
import {
  metricAccountDeletionCompleted,
  metricAccountDeletionFanout,
  metricAccountDeletionFanoutPendingAge,
  metricAccountDeletionOrganisation,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  safeErrorSummary,
  withAccountDeletion,
} from "../metrics";
import { leaveApp } from "./app-enrollments";
import { jobPredatesRestoreRecord } from "./deletion-job-shape";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 7-day soft-delete grace window. */
const ACCOUNT_DELETION_GRACE_SECONDS = 7 * 24 * 60 * 60;

/** How long an erased account's handles stay held after its hard delete: 30 days. */
const HANDLE_HOLD_AFTER_ERASURE_SECONDS = 30 * 24 * 60 * 60;

/** Per-bridge timeout — locked by `wiki/compliance/dsar.md` line 96. */
const FANOUT_TIMEOUT_MS = 10_000;

/** Sentinel timestamp used when a bridge target is not enrolled at soft-delete time. */
const NOT_APPLICABLE_SENTINEL = -1;

/**
 * Downstream service base URLs for the deletion fan-out. Threaded in by the
 * caller (Bun `local.ts` reads `process.env`; the Workers `scheduled` handler
 * reads the `env` binding) because on workerd these arrive via wrangler `[vars]`
 * — module-top `process.env` reads are not reliable for bindings there. Falls
 * back to the local dev ports when unset.
 */
interface FanOutUrls {
  pulseApiUrl?: string;
  zapApiUrl?: string;
}

/** The two resolved bridge bases, after defaults and env fallbacks are applied. */
interface FanOutBaseUrls {
  pulse: string;
  zap: string;
}

const DEFAULT_PULSE_API_URL = "http://localhost:3001";
const DEFAULT_ZAP_API_URL = "http://localhost:3002";

const resolveFanOutUrls = (urls: FanOutUrls = {}): FanOutBaseUrls => ({
  pulse: urls.pulseApiUrl ?? process.env.PULSE_API_URL ?? DEFAULT_PULSE_API_URL,
  zap: urls.zapApiUrl ?? process.env.ZAP_API_URL ?? DEFAULT_ZAP_API_URL,
});

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

class BridgePurgeError extends Data.TaggedError("BridgePurgeError")<{
  readonly service: DeletionFanoutService;
  readonly cause: unknown;
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
}

interface RequestErasureOutput {
  readonly accountId: string;
  /** Unix seconds when the account is scheduled for hard delete. */
  readonly scheduledFor: number;
  /** True if this call inserted a new tombstone; false if one already existed. */
  readonly newlyScheduled: boolean;
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
 * `pulse_done_at` or `zap_done_at` for a new job, decided in the statement
 * that writes it: NULL while the account has an open enrolment in `app`, so
 * the fan-out reaches it, else the not-applicable sentinel.
 */
const bridgeMark = (accountId: string, app: AppEnrollmentApp, column: AnySQLiteColumn) =>
  sql`CASE WHEN EXISTS (
      SELECT 1 FROM app_enrollments e
      WHERE e.account_id = ${accountId} AND e.app = ${app} AND e.left_at IS NULL)
    THEN NULL ELSE ${NOT_APPLICABLE_SENTINEL} END`.as(column.name);

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
    const { accountId, cancel, reason = "user_request", heldHandleDigest, choices } = input;
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
      return { accountId, scheduledFor: account.hardDeleteAt, newlyScheduled: false };
    }

    // The handles to hold, as digests. A profile made after this read and
    // before the batch is in the restore record (built in SQL below) but has
    // no hold.
    const held = rows.flatMap((row) => (row.handle === null ? [] : [heldHandleDigest(row.handle)]));

    const hardDeleteAt = now + ACCOUNT_DELETION_GRACE_SECONDS;
    const storedChoices =
      choices !== undefined && Object.keys(choices).length > 0 ? JSON.stringify(choices) : null;

    // `email_changes` and `security_events` rows stay, as legal-obligation
    // records (Art. 6(1)(c)+(f)), here and at hard delete. Hard delete keeps
    // their `account_id` as it is: neither table has a foreign key to
    // `accounts`, so the account row goes with the audit rows still naming it.
    const statements: BatchItem<"sqlite">[] = [
      // 1. The deletion job, first: a second request's job already standing
      //    stops the batch here, before anything else is written, on either
      //    driver. Its random `job_id` names this job alone. Each bridge is
      //    marked here, from the enrolments as this statement reads them: one
      //    the account has no open enrolment in is pre-marked done with a
      //    sentinel, so the sweeper does not call services the user never
      //    used. `restore` is built from the same rows: each profile before
      //    redaction, and the open enrolments.
      db.insert(deletionJobs).select(
        db
          .select({
            accountId: bound(accountId, deletionJobs.accountId),
            softDeletedAt: bound(now, deletionJobs.softDeletedAt),
            hardDeleteAt: bound(hardDeleteAt, deletionJobs.hardDeleteAt),
            pulseDoneAt: bridgeMark(accountId, "pulse", deletionJobs.pulseDoneAt),
            zapDoneAt: bridgeMark(accountId, "zap", deletionJobs.zapDoneAt),
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
      return { accountId, scheduledFor: raced, newlyScheduled: false };
    }

    // Side-effect metrics outside the tx so a failed metric never aborts the
    // soft-delete write.
    metricSecurityEventRecorded("account_deletion_scheduled");
    metricSessionSecurityInvalidation("session_revoke_all");
    metricAccountDeletionCompleted("soft", "user");

    return { accountId, scheduledFor: hardDeleteAt, newlyScheduled: true };
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

/** What {@link checkErasureChoices} found. */
export type ErasureChoicesCheck =
  | { readonly kind: "ok"; readonly choices: ErasureChoices }
  /** An answer that names an action of the account and is not one of its choices. */
  | { readonly kind: "invalid"; readonly action: string }
  /** Organisations with no default and no answer: the person must choose. */
  | { readonly kind: "open"; readonly open: ReadonlyArray<OwnedOrganisation> };

/**
 * Checks the answers to a deletion's open actions against the organisations
 * the account owns ({@link listOwnedOrganisations}). An answer to an action
 * the account does not have is ignored. An answer is refused when its action
 * is answered twice, when its choice is not one the organisation allows, or
 * when it names a successor who is not a member of that organisation from
 * another account (one read, for every named successor at once). Then every
 * organisation with no default must have an answer. On success answers the
 * choices to store, keyed by action id.
 */
export const checkErasureChoices = (
  accountId: string,
  owned: ReadonlyArray<OwnedOrganisation>,
  answers: ReadonlyArray<ErasureChoiceAnswer>,
): Effect.Effect<ErasureChoicesCheck, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const byAction = new Map(owned.map((org) => [organisationActionId(org.orgId), org]));
    const chosen = new Map<string, ErasureChoice>();
    const named: Array<{ action: string; orgId: string; profileId: string }> = [];
    for (const answer of answers) {
      const org = byAction.get(answer.action);
      if (!org) continue;
      const allowed = organisationChoices(org) as ReadonlyArray<string>;
      if (chosen.has(answer.action) || !allowed.includes(answer.choice)) {
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

    const open = owned.filter(
      (org) =>
        organisationDefaultChoice(org) === null && !chosen.has(organisationActionId(org.orgId)),
    );
    if (open.length > 0) return { kind: "open", open } as const;
    return { kind: "ok", choices: Object.fromEntries(chosen) } as const;
  });

// ---------------------------------------------------------------------------
// Cross-service fan-out
// ---------------------------------------------------------------------------

interface BridgeBody {
  readonly accountId: string;
  readonly profileIds: string[];
}

const buildBridgeBody = (accountId: string): Effect.Effect<BridgeBody, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () => db.select({ id: users.id }).from(users).where(eq(users.accountId, accountId)),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    return { accountId, profileIds: rows.map((r) => r.id) };
  });

const dispatchBridge = (
  service: DeletionFanoutService,
  url: string,
  scope: string,
  body: BridgeBody,
): Effect.Effect<void, BridgePurgeError> =>
  arcPostJsonEffect(`${url}/internal/account-deleted`, body, {
    audience: service === "pulse" ? "pulse-api" : "zap-api",
    scope,
    timeoutMs: FANOUT_TIMEOUT_MS,
  }).pipe(
    Effect.tap(() => Effect.sync(() => metricAccountDeletionFanout(service, "ok"))),
    Effect.tapError((cause) =>
      Effect.sync(() => {
        const result = cause instanceof Error && cause.name === "AbortError" ? "timeout" : "error";
        metricAccountDeletionFanout(service, result);
      }),
    ),
    Effect.mapError((cause) => new BridgePurgeError({ service, cause })),
    Effect.asVoid,
  );

const markBridgeDone = (
  service: DeletionFanoutService,
  accountId: string,
): Effect.Effect<void, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);
    const updates = service === "pulse" ? { pulseDoneAt: now } : { zapDoneAt: now };
    yield* Effect.tryPromise({
      try: () => db.update(deletionJobs).set(updates).where(eq(deletionJobs.accountId, accountId)),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
  });

/**
 * Marks the account's purge as begun, before a sweep purges anything, and
 * answers whether the sweep may go on: true when this call wrote the mark —
 * the job still exists, no other sweep has marked it, and its grace window
 * has passed by `nowSec`. A cancel that comes after is refused; one that came
 * before has removed the job, and this answers false.
 *
 * For the hard delete (`bridgesDone`), the mark is written only while both
 * bridges still read done: an app join refused since the sweep read the job
 * may have put one back to NULL, and then the fan-out runs first.
 */
const claimPurge = (
  accountId: string,
  nowSec: number,
  { bridgesDone = false }: { readonly bridgesDone?: boolean } = {},
): Effect.Effect<boolean, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const claimed = yield* Effect.tryPromise({
      try: () =>
        db
          .update(deletionJobs)
          .set({ purgeStartedAt: nowSec })
          .where(
            and(
              eq(deletionJobs.accountId, accountId),
              isNull(deletionJobs.purgeStartedAt),
              lte(deletionJobs.hardDeleteAt, nowSec),
              bridgesDone ? isNotNull(deletionJobs.pulseDoneAt) : undefined,
              bridgesDone ? isNotNull(deletionJobs.zapDoneAt) : undefined,
            ),
          ),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    return rowsChanged(claimed) === 1;
  });

/**
 * Runs the cross-service fan-out for a still-pending deletion job, for the
 * retry sweeper (every bridge without `*_done_at` set). A job the sweep read
 * unclaimed is claimed first ({@link claimPurge}), at `nowSec`, the sweep's
 * clock; if the claim answers false (a cancel landed since the sweep read
 * the job) nothing is sent. A job already claimed by an earlier pass is not
 * written again.
 *
 * Per-bridge result is captured via Effect.result so a failing bridge does
 * not abort the parent — sweeper picks up the unfinished half on its next
 * cycle.
 */
const runFanOut = (
  job: Pick<DeletionJob, "accountId" | "pulseDoneAt" | "zapDoneAt" | "purgeStartedAt">,
  urls: FanOutUrls,
  nowSec: number,
): Effect.Effect<void, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { pulse, zap } = resolveFanOutUrls(urls);
    const body = yield* buildBridgeBody(job.accountId);
    if (job.purgeStartedAt === null && !(yield* claimPurge(job.accountId, nowSec))) return;
    const tasks: Array<Effect.Effect<void, never, Db>> = [];
    if (job.pulseDoneAt === null) {
      tasks.push(
        dispatchBridge("pulse", pulse, "account:erase", body).pipe(
          Effect.flatMap(() => markBridgeDone("pulse", job.accountId)),
          Effect.catch(() => Effect.void),
        ),
      );
    }
    if (job.zapDoneAt === null) {
      tasks.push(
        dispatchBridge("zap", zap, "account:erase", body).pipe(
          Effect.flatMap(() => markBridgeDone("zap", job.accountId)),
          Effect.catch(() => Effect.void),
        ),
      );
    }
    yield* Effect.all(tasks, { concurrency: "unbounded" });
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
 * Single sweeper pass. Hard-deletes every account whose deletion_jobs row
 * has crossed `hard_delete_at` AND has both bridges done (or pre-marked
 * not-applicable). Returns the count of hard-deletes performed.
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
    // of permanently-stuck bridges (NULL `*_done_at`) would otherwise fill the
    // batch and starve the rows whose fan-out is complete. SQLite uses the
    // `deletion_jobs_hard_delete_idx` for `hard_delete_at` and falls back to
    // a sequential scan over the small NULL-checks — the candidate set is
    // tiny (only in-flight deletions).
    const ready = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            accountId: deletionJobs.accountId,
            purgeStartedAt: deletionJobs.purgeStartedAt,
            choices: deletionJobs.choices,
          })
          .from(deletionJobs)
          .where(
            and(
              lte(deletionJobs.hardDeleteAt, nowSec),
              sql`${deletionJobs.pulseDoneAt} IS NOT NULL`,
              sql`${deletionJobs.zapDoneAt} IS NOT NULL`,
            ),
          )
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
      !(yield* claimPurge(accountId, nowSec, { bridgesDone: true }))
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
      //    job goes only while both bridges still read done: an app join
      //    refused since the sweep read it may have put one back to NULL.
      //    Then the job stays, the `accounts` delete below fails on the job's
      //    foreign key, and D1 rolls the whole batch back, so the fan-out
      //    reaches the app before the account is erased.
      db
        .delete(deletionJobs)
        .where(
          and(
            eq(deletionJobs.accountId, accountId),
            isNotNull(deletionJobs.pulseDoneAt),
            isNotNull(deletionJobs.zapDoneAt),
          ),
        ),
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

/**
 * Fan-out sweeper pass — the SOLE driver of cross-service purges.
 *
 * Bridges fire only once the 7-day grace window has elapsed
 * (`hard_delete_at <= now`). Purging Pulse / Zap at soft-delete time would
 * destroy app data the user was promised they could get back by
 * cancelling, and the per-account purge ledger on the Pulse side would
 * then block any future re-purge after a restore-then-redelete.
 *
 * Also serves as the retry path: rows whose earlier fan-out attempt
 * failed keep their NULL `*_done_at` and are re-dispatched each cycle.
 * Captures the age of each pending row so dashboards can spot a
 * chronically-stuck bridge.
 */
export const runFanOutRetrySweep = (
  opts: { batchSize?: number; nowMs?: number } & FanOutUrls = {},
): Effect.Effect<{ retried: number }, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const batchSize = opts.batchSize ?? 100;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1_000);

    const pending = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            accountId: deletionJobs.accountId,
            hardDeleteAt: deletionJobs.hardDeleteAt,
            pulseDoneAt: deletionJobs.pulseDoneAt,
            zapDoneAt: deletionJobs.zapDoneAt,
            purgeStartedAt: deletionJobs.purgeStartedAt,
          })
          .from(deletionJobs)
          .where(
            and(
              lte(deletionJobs.hardDeleteAt, nowSec),
              or(isNull(deletionJobs.pulseDoneAt), isNull(deletionJobs.zapDoneAt)),
            ),
          )
          .limit(batchSize),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });

    // Bounded concurrency. Sequential `for ... yield*` would take
    // 100 × 20s = ~33 minutes per cycle worst-case (each row dispatches
    // two 10s-timeout HTTP calls). Per-row failures are already isolated
    // inside `runFanOut` via `Effect.catch`, so concurrency is safe.
    yield* Effect.forEach(
      pending,
      (row) => {
        // Age = time since the grace window expired (when fan-out became
        // eligible), NOT since soft-delete — otherwise every sample would
        // saturate at ≥7 days and the stuck-bridge signal would be lost.
        const age = nowSec - row.hardDeleteAt;
        if (row.pulseDoneAt === null) metricAccountDeletionFanoutPendingAge("pulse", age);
        if (row.zapDoneAt === null) metricAccountDeletionFanoutPendingAge("zap", age);
        return runFanOut(row, { pulseApiUrl: opts.pulseApiUrl, zapApiUrl: opts.zapApiUrl }, nowSec);
      },
      { concurrency: 8, discard: true },
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
