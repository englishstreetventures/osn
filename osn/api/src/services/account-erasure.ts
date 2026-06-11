import {
  accounts,
  appEnrollments,
  blocks,
  connections,
  deletionJobs,
  organisationMembers,
  passkeys,
  recoveryCodes,
  securityEvents,
  sessions,
  users,
} from "@osn/db/schema";
import type { DeletionJob } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import type { AppEnrollmentApp, DeletionFanoutService } from "@shared/observability/metrics";
import { and, eq, inArray, isNull, lte, ne, or, sql } from "drizzle-orm";
import { Data, Effect } from "effect";

import { arcPostJsonEffect } from "../lib/outbound-arc";
import {
  metricAccountDeletionCompleted,
  metricAccountDeletionFanout,
  metricAccountDeletionFanoutPendingAge,
  metricSecurityEventRecorded,
  metricSessionSecurityInvalidation,
  withAccountDeletion,
} from "../metrics";
import { listActiveApps, leaveApp } from "./app-enrollments";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 7-day soft-delete grace window. */
export const ACCOUNT_DELETION_GRACE_SECONDS = 7 * 24 * 60 * 60;

/** Per-bridge timeout — locked by `wiki/compliance/dsar.md` line 96. */
const FANOUT_TIMEOUT_MS = 10_000;

/** Sentinel timestamp used when a bridge target is not enrolled at soft-delete time. */
const NOT_APPLICABLE_SENTINEL = -1;

const PULSE_API_URL = process.env.PULSE_API_URL ?? "http://localhost:3001";
const ZAP_API_URL = process.env.ZAP_API_URL ?? "http://localhost:3002";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AccountErasureDbError extends Data.TaggedError("AccountErasureDbError")<{
  readonly cause: unknown;
}> {}

export class AccountNotFoundError extends Data.TaggedError("AccountNotFoundError")<{
  readonly accountId: string;
}> {}

export class DeletionAlreadyPendingError extends Data.TaggedError("DeletionAlreadyPendingError")<{
  readonly accountId: string;
  readonly scheduledFor: number;
}> {}

export class BridgePurgeError extends Data.TaggedError("BridgePurgeError")<{
  readonly service: DeletionFanoutService;
  readonly cause: unknown;
}> {}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface RequestErasureInput {
  readonly accountId: string;
  /** Hashed session id of the requesting session. Kept alive as the cancellation handle. */
  readonly cancelSessionId: string | null;
  /** "user_request" | "minor_detected" | "admin". */
  readonly reason?: string;
}

export interface RequestErasureOutput {
  readonly accountId: string;
  /** Unix seconds when the account is scheduled for hard delete. */
  readonly scheduledFor: number;
  /** True if this call inserted a new tombstone; false if one already existed. */
  readonly newlyScheduled: boolean;
}

const newId = (prefix: string): string =>
  `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

/**
 * Soft-deletes the account: redacts identity fields, nukes credentials,
 * revokes all-but-the-requesting session, inserts a deletion_jobs row.
 * Returns the existing row if the account is already tombstoned (idempotent).
 *
 * The cross-service fan-out runs OUTSIDE the transaction; failures don't
 * block the soft-delete (the user's 202 returns regardless), and the
 * sweeper retries unfinished bridges later.
 */
export const requestErasure = (
  input: RequestErasureInput,
): Effect.Effect<RequestErasureOutput, AccountNotFoundError | AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { accountId, cancelSessionId, reason = "user_request" } = input;
    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);

    // Idempotency check: existing job → return current scheduled timestamp.
    const existing = yield* Effect.tryPromise({
      try: () =>
        db.select().from(deletionJobs).where(eq(deletionJobs.accountId, accountId)).limit(1),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    if (existing[0]) {
      return {
        accountId,
        scheduledFor: existing[0].hardDeleteAt,
        newlyScheduled: false,
      };
    }

    // Pre-resolve enrolled apps so the deletion job knows whether to track
    // each bridge or pre-mark it done.
    const enrolledApps = yield* listActiveApps(accountId).pipe(
      Effect.mapError((e) => new AccountErasureDbError({ cause: e })),
    );
    const enrolledSet = new Set(enrolledApps);

    // Confirm the account exists (and is not already tombstoned via the
    // accounts.deleted_at column without a deletion_jobs row — defensive).
    const accountRow = yield* Effect.tryPromise({
      try: () => db.select().from(accounts).where(eq(accounts.id, accountId)).limit(1),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    const account = accountRow[0];
    if (!account) {
      return yield* Effect.fail(new AccountNotFoundError({ accountId }));
    }

    const hardDeleteAt = now + ACCOUNT_DELETION_GRACE_SECONDS;

    // Atomic soft-delete transaction. Identity is redacted, credentials nuked,
    // all-but-the-requesting session revoked, and a deletion_jobs row written.
    //
    // We KEEP `email_changes` and `security_events` rows for the legal-
    // obligation retention window (Art. 6(1)(c)) — they reference accountId
    // which still exists during the grace window. The hard-delete sweeper
    // NULLs the account_id reference at hard delete time so the audit rows
    // survive without an orphan FK violation.
    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          // 1. Tombstone the account row.
          await tx.update(accounts).set({ deletedAt: now }).where(eq(accounts.id, accountId));

          // 2. Redact identity on every profile owned by this account.
          //    Handle becomes `deleted_<usrId-suffix>` (preserves uniqueness),
          //    display name + avatar are nulled.
          //
          //    P-W1: a single bulk UPDATE using a SQL expression instead of
          //    a per-row loop. Constant statement count regardless of
          //    `accounts.maxProfiles`; the previous loop held the write
          //    lock across N round-trips.
          await tx
            .update(users)
            .set({
              handle: sql`'deleted_' || replace(${users.id}, 'usr_', '')`,
              displayName: null,
              avatarUrl: null,
              updatedAt: new Date(),
            })
            .where(eq(users.accountId, accountId));

          // 3. Nuke credentials immediately. A stolen session/access/recovery
          //    cannot be used to re-authenticate during the grace window.
          await tx.delete(passkeys).where(eq(passkeys.accountId, accountId));
          await tx.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId));

          // 4. Revoke all sessions EXCEPT the cancellation handle. The
          //    requesting session stays alive as the only path to cancel
          //    during the 7-day grace window. Without a cancellation handle
          //    the user must use a recovery-code login to cancel.
          if (cancelSessionId) {
            await tx
              .delete(sessions)
              .where(and(eq(sessions.accountId, accountId), ne(sessions.id, cancelSessionId)));
          } else {
            await tx.delete(sessions).where(eq(sessions.accountId, accountId));
          }

          // 5. Audit event.
          await tx.insert(securityEvents).values({
            id: newId("sev_"),
            accountId,
            kind: "account_deletion_scheduled",
            createdAt: now,
            acknowledgedAt: null,
          });

          // 6. Close every active app enrollment in the same tx (idempotent —
          //    the leaveApp service helper handles a second call as a no-op,
          //    but during full-account delete we know they should all close).
          await tx
            .update(appEnrollments)
            .set({ leftAt: now })
            .where(and(eq(appEnrollments.accountId, accountId), isNull(appEnrollments.leftAt)));

          // 7. Insert the deletion_jobs row. Bridges not enrolled at this
          //    moment are pre-marked done with a sentinel so the sweeper
          //    doesn't retry calls to services the user never used.
          await tx.insert(deletionJobs).values({
            accountId,
            softDeletedAt: now,
            hardDeleteAt,
            pulseDoneAt: enrolledSet.has("pulse") ? null : NOT_APPLICABLE_SENTINEL,
            zapDoneAt: enrolledSet.has("zap") ? null : NOT_APPLICABLE_SENTINEL,
            reason,
            cancelSessionId,
          });
        }),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });

    // Side-effect metrics outside the tx so a failed metric never aborts the
    // soft-delete write.
    metricSecurityEventRecorded("account_deletion_scheduled");
    metricSessionSecurityInvalidation("session_revoke_all");
    metricAccountDeletionCompleted("soft", "user");

    return { accountId, scheduledFor: hardDeleteAt, newlyScheduled: true };
  }).pipe(withAccountDeletion("soft"));

/**
 * Cancellation: removes the deletion_jobs row + clears `accounts.deleted_at`.
 * Caller must have re-authenticated using the cancellation session (verified
 * upstream in the route handler) — we don't re-check session ownership here.
 * Idempotent: returns `{ cancelled: false }` when no job exists.
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

    // S-H1: cancellation is only honoured INSIDE the grace window. Once
    // `hardDeleteAt` has passed, the fan-out sweep may already be purging
    // Pulse / Zap data — resurrecting the OSN account at that point would
    // leave it half-erased downstream with no way to re-trigger the purge
    // (the per-account purge ledger treats it as already processed).
    if (existing[0].hardDeleteAt <= now) {
      return { cancelled: false };
    }

    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          await tx.delete(deletionJobs).where(eq(deletionJobs.accountId, accountId));
          await tx.update(accounts).set({ deletedAt: null }).where(eq(accounts.id, accountId));
          await tx.insert(securityEvents).values({
            id: newId("sev_"),
            accountId,
            kind: "account_deletion_cancelled",
            createdAt: now,
            acknowledgedAt: null,
          });
        }),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
    metricSecurityEventRecorded("account_deletion_cancelled");
    metricAccountDeletionCompleted("cancelled", "user");
    return { cancelled: true };
  });

/**
 * Returns the current deletion status for an account — used by the
 * `GET /account/deletion-status` endpoint and by the auth path to refuse
 * mutations on tombstoned accounts.
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
 * Runs the cross-service fan-out for a still-pending deletion job. Used by
 * both the request handler (for the initial best-effort fan-out, fire-and-
 * forget after returning 202) and the retry sweeper (for any bridge that
 * came back without `*_done_at` set).
 *
 * Per-bridge result is captured via Effect.either so a failing bridge does
 * not abort the parent — sweeper picks up the unfinished half on its next
 * cycle.
 */
export const runFanOut = (
  job: Pick<DeletionJob, "accountId" | "pulseDoneAt" | "zapDoneAt">,
): Effect.Effect<void, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const body = yield* buildBridgeBody(job.accountId);
    const tasks: Array<Effect.Effect<void, never, Db>> = [];
    if (job.pulseDoneAt === null) {
      tasks.push(
        dispatchBridge("pulse", PULSE_API_URL, "account:erase", body).pipe(
          Effect.flatMap(() => markBridgeDone("pulse", job.accountId)),
          Effect.catchAll(() => Effect.void),
        ),
      );
    }
    if (job.zapDoneAt === null) {
      tasks.push(
        dispatchBridge("zap", ZAP_API_URL, "account:erase", body).pipe(
          Effect.flatMap(() => markBridgeDone("zap", job.accountId)),
          Effect.catchAll(() => Effect.void),
        ),
      );
    }
    yield* Effect.all(tasks, { concurrency: "unbounded" });
  });

// ---------------------------------------------------------------------------
// Hard-delete sweeper
// ---------------------------------------------------------------------------

/**
 * Single sweeper pass. Hard-deletes every account whose deletion_jobs row
 * has crossed `hard_delete_at` AND has both bridges done (or pre-marked
 * not-applicable). Returns the count of hard-deletes performed.
 *
 * Designed to be called on a `setInterval` (every 6 h in production) with
 * a Redis-locked single-instance guard outside this function. The function
 * itself is safe to run concurrently — each account is processed in its
 * own per-row transaction.
 */
export const runHardDeleteSweep = (
  opts: { batchSize?: number; nowMs?: number } = {},
): Effect.Effect<{ purged: number }, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const batchSize = opts.batchSize ?? 100;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1_000);

    // P-C1: gating predicate is in SQL, not JS post-filter. A handful of
    // permanently-stuck bridges (NULL `*_done_at`) would otherwise fill the
    // batch slot and starve fan-out-complete rows. SQLite uses the
    // `deletion_jobs_hard_delete_idx` for `hard_delete_at` and falls back to
    // a sequential scan over the small NULL-checks — the candidate set is
    // tiny (only in-flight deletions).
    const ready = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ accountId: deletionJobs.accountId })
          .from(deletionJobs)
          .where(
            and(
              lte(deletionJobs.hardDeleteAt, nowSec),
              sql`${deletionJobs.pulseDoneAt} IS NOT NULL`,
              sql`${deletionJobs.zapDoneAt} IS NOT NULL`,
            ),
          )
          .limit(batchSize),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });

    let purged = 0;
    for (const row of ready) {
      yield* hardDeleteAccount(row.accountId).pipe(
        Effect.tap(() => Effect.sync(() => metricAccountDeletionCompleted("hard", "sweeper"))),
      );
      purged += 1;
    }
    return { purged };
  }).pipe(withAccountDeletion("hard"));

/**
 * Removes all PII-bearing rows referencing this account, then the account
 * itself. Audit rows in `security_events` and `email_changes` are
 * intentionally preserved to satisfy GDPR Art. 6(1)(c) legal-obligation
 * retention (12 mo / 90 d windows defined in `wiki/compliance/retention.md`).
 *
 * The `account_id` FK is non-enforcing (sqlite without `PRAGMA foreign_keys=ON`,
 * `ON DELETE no action`), so the surviving audit rows remain queryable by
 * accountId until their own retention sweepers (C-M2) age them out. The
 * `users.handle` was already redacted to `deleted_<id>` at soft-delete time
 * so the surviving accountId no longer correlates to a person.
 *
 * P-W4: cascade deletes use a single `inArray` per child table instead of
 * looping per profile so the transaction holds the write lock for one
 * round-trip per table regardless of profile count.
 */
const hardDeleteAccount = (accountId: string): Effect.Effect<void, AccountErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    yield* Effect.tryPromise({
      try: () =>
        db.transaction(async (tx) => {
          const profileIds = (
            await tx.select({ id: users.id }).from(users).where(eq(users.accountId, accountId))
          ).map((r) => r.id);

          if (profileIds.length > 0) {
            await tx
              .delete(connections)
              .where(
                or(
                  inArray(connections.requesterId, profileIds),
                  inArray(connections.addresseeId, profileIds),
                ),
              );
            await tx
              .delete(blocks)
              .where(
                or(inArray(blocks.blockerId, profileIds), inArray(blocks.blockedId, profileIds)),
              );
            await tx
              .delete(organisationMembers)
              .where(inArray(organisationMembers.profileId, profileIds));
            await tx.delete(users).where(eq(users.accountId, accountId));
          }

          await tx.delete(sessions).where(eq(sessions.accountId, accountId));
          await tx.delete(passkeys).where(eq(passkeys.accountId, accountId));
          await tx.delete(recoveryCodes).where(eq(recoveryCodes.accountId, accountId));
          await tx.delete(deletionJobs).where(eq(deletionJobs.accountId, accountId));
          await tx
            .update(appEnrollments)
            .set({ leftAt: Math.floor(Date.now() / 1_000) })
            .where(and(eq(appEnrollments.accountId, accountId), isNull(appEnrollments.leftAt)));

          // INTENTIONALLY KEPT (S-H5 / C-H1):
          //   - security_events   — Art. 6(1)(c), 12-month retention sweeper (C-M2)
          //   - email_changes     — Art. 6(1)(c), 90-day retention sweeper  (C-M2)
          // Both retain the now-orphaned `account_id`. PII linkage is broken
          // because `users.handle` was redacted at soft-delete and the
          // `accounts.email` row is gone here.
          await tx.delete(accounts).where(eq(accounts.id, accountId));
        }),
      catch: (cause) => new AccountErasureDbError({ cause }),
    });
  });

/**
 * Fan-out sweeper pass — the SOLE driver of cross-service purges.
 *
 * S-H1: bridges only fire once the 7-day grace window has elapsed
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
  opts: { batchSize?: number; nowMs?: number } = {},
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

    // P-W3: bounded concurrency. Sequential `for ... yield*` would take
    // 100 × 20s = ~33 minutes per cycle worst-case (each row dispatches
    // two 10s-timeout HTTP calls). Per-row failures are already isolated
    // inside `runFanOut` via `Effect.catchAll`, so concurrency is safe.
    yield* Effect.forEach(
      pending,
      (row) => {
        // Age = time since the grace window expired (when fan-out became
        // eligible), NOT since soft-delete — otherwise every sample would
        // saturate at ≥7 days and the stuck-bridge signal would be lost.
        const age = nowSec - row.hardDeleteAt;
        if (row.pulseDoneAt === null) metricAccountDeletionFanoutPendingAge("pulse", age);
        if (row.zapDoneAt === null) metricAccountDeletionFanoutPendingAge("zap", age);
        return runFanOut(row);
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
