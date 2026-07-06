import {
  events,
  eventComms,
  eventLineup,
  eventRsvps,
  pulseAccountOnboarding,
  pulseAccountPurges,
  pulseCloseFriends,
  pulseDeletionJobs,
  pulseProfileAccounts,
  pulseUsers,
} from "@pulse/db/schema";
import type { PulseDeletionJob } from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { commitBatch } from "@shared/db-utils";
import type {
  DeletionCompletedResult,
  DeletionCompletedSource,
} from "@shared/observability/metrics";
import { and, eq, inArray, lte, ne, or } from "drizzle-orm";
import { Data, Effect } from "effect";

import {
  metricPulseAccountDeletionCompleted,
  metricPulseHostCancelledHardDelete,
  withPulseAccountDeletion,
} from "../metrics";

/**
 * Pulse-side account erasure (Flow B — leave Pulse).
 *
 *   1. `requestErasure` — soft-deletes Pulse-scoped data for one profile,
 *      flips hosted events into a 14-day public cancellation window, and
 *      writes a pulse_deletion_jobs row.
 *   2. `cancelErasure` — clears the row + restores Pulse data WHERE
 *      possible (RSVPs / close-friends are gone forever; events come back
 *      since cancellation is non-destructive within the 14-day window).
 *   3. `runHardDeleteSweep` — purges residual rows after the 7-day window.
 *   4. `runEventCancellationSweep` — hard-deletes events whose
 *      `hard_delete_at` (= cancelled_at + 14d) has passed.
 *   5. `purgeAccount` — endpoint hit by osn-api's full-account-delete
 *      fan-out. Hard-deletes immediately (no grace), since OSN already
 *      enforced its own 7-day window before fanning out.
 */

export const PULSE_LEAVE_GRACE_SECONDS = 7 * 24 * 60 * 60;
export const EVENT_CANCELLATION_WINDOW_SECONDS = 14 * 24 * 60 * 60;

export class PulseErasureDbError extends Data.TaggedError("PulseErasureDbError")<{
  readonly cause: unknown;
}> {}

export class PulseDeletionAlreadyPendingError extends Data.TaggedError(
  "PulseDeletionAlreadyPendingError",
)<{
  readonly profileId: string;
  readonly scheduledFor: number;
}> {}

export interface RequestErasureInput {
  readonly profileId: string;
  readonly accountId: string;
  readonly reason?: string;
}

export interface RequestErasureOutput {
  readonly profileId: string;
  readonly scheduledFor: number;
  readonly newlyScheduled: boolean;
}

const recordCompletion = (result: DeletionCompletedResult, source: DeletionCompletedSource) =>
  Effect.sync(() => metricPulseAccountDeletionCompleted(result, source));

/**
 * Soft-delete the user's Pulse identity. **Personal data (RSVPs,
 * close-friends, comms, pulse_users) is NOT deleted at this stage** —
 * cancellation within the 7-day grace must be fully reversible per the
 * user-facing contract. Only:
 *
 *   - flips hosted events to `cancelled_at = now`,
 *     `hard_delete_at = now + 14d`, `cancellation_reason = "host_left"`
 *     (this is reversible too — `cancelErasure` un-cancels them)
 *   - inserts the `pulse_deletion_jobs` row
 *
 * The 7-day hard-delete sweeper (`runHardDeleteSweep`) is what actually
 * purges RSVPs, close-friends, comms, and `pulse_users` rows. If the
 * user cancels in the grace window, none of this data was ever lost.
 *
 * `enrollment_notify_done_at` is left NULL — the route handler runs the
 * ARC callback to osn-api (`/internal/app-enrollment/leave`) outside the
 * transaction. The retry sweeper picks it up if the callback failed.
 */
export const requestErasure = (
  input: RequestErasureInput,
): Effect.Effect<RequestErasureOutput, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    const { profileId, accountId, reason = "user_request" } = input;
    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);

    const existing = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(pulseDeletionJobs)
          .where(eq(pulseDeletionJobs.profileId, profileId))
          .limit(1),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });
    if (existing[0]) {
      return {
        profileId,
        scheduledFor: existing[0].hardDeleteAt,
        newlyScheduled: false,
      };
    }

    const hardDeleteAt = now + PULSE_LEAVE_GRACE_SECONDS;
    const eventCancelHardDeleteAt = now + EVENT_CANCELLATION_WINDOW_SECONDS;

    yield* Effect.tryPromise({
      // Atomic batch (D1) / sequential (bun:sqlite) — D1 has no interactive
      // transaction. Both statements are pure writes with no intermediate read.
      try: () =>
        commitBatch(db, [
          // Cancel hosted events that aren't already finished or cancelled.
          // The 14-day public-cancellation window starts now; the
          // event-cancellation sweeper hard-deletes them when the window
          // closes (or the user-restore path un-cancels them). Status is
          // also flipped to "cancelled" so the status-aware UI surfaces
          // the right copy without reading `cancelled_at` everywhere.
          db
            .update(events)
            .set({
              cancelledAt: now,
              hardDeleteAt: eventCancelHardDeleteAt,
              cancellationReason: "host_left",
              status: "cancelled",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(events.createdByProfileId, profileId),
                ne(events.status, "finished"),
                ne(events.status, "cancelled"),
              ),
            ),
          db.insert(pulseDeletionJobs).values({
            profileId,
            accountId,
            softDeletedAt: now,
            hardDeleteAt,
            enrollmentNotifyDoneAt: null,
            reason,
          }),
        ]),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });

    yield* recordCompletion("soft", "user");

    return { profileId, scheduledFor: hardDeleteAt, newlyScheduled: true };
  }).pipe(withPulseAccountDeletion("soft"));

/**
 * Cancellation: removes the pulse_deletion_jobs row + un-cancels events
 * that are still within their 14-day cancellation window. RSVPs,
 * close-friends, comms, and pulse_users are NOT touched here because
 * `requestErasure` no longer deletes them at soft-delete time — they
 * stay in place during the 7-day grace and are only purged by the hard-
 * delete sweeper, which means cancellation is fully reversible.
 */
export const cancelErasure = (
  profileId: string,
): Effect.Effect<{ cancelled: boolean }, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const existing = yield* Effect.tryPromise({
      try: () =>
        db
          .select()
          .from(pulseDeletionJobs)
          .where(eq(pulseDeletionJobs.profileId, profileId))
          .limit(1),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });
    if (!existing[0]) return { cancelled: false };

    const nowSec = Math.floor(Date.now() / 1_000);

    yield* Effect.tryPromise({
      // Atomic batch (D1) / sequential (bun:sqlite) — pure writes, no read.
      try: () =>
        commitBatch(db, [
          db.delete(pulseDeletionJobs).where(eq(pulseDeletionJobs.profileId, profileId)),
          // Un-cancel events that haven't crossed their hard-delete deadline yet.
          db
            .update(events)
            .set({
              cancelledAt: null,
              hardDeleteAt: null,
              cancellationReason: null,
              status: "upcoming",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(events.createdByProfileId, profileId),
                eq(events.cancellationReason, "host_left"),
                lte(events.cancelledAt, nowSec),
                // Defensive — only restore events whose hard-delete window
                // hasn't already started purging (i.e. the sweeper hasn't
                // yet hit them in a future cycle).
              ),
            ),
        ]),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });

    yield* recordCompletion("cancelled", "user");
    return { cancelled: true };
  });

/**
 * Returns the deletion status for a Pulse profile.
 */
export const getDeletionStatus = (
  profileId: string,
): Effect.Effect<
  { scheduled: false } | { scheduled: true; scheduledFor: number; softDeletedAt: number },
  PulseErasureDbError,
  Db
> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const rows = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            hardDeleteAt: pulseDeletionJobs.hardDeleteAt,
            softDeletedAt: pulseDeletionJobs.softDeletedAt,
          })
          .from(pulseDeletionJobs)
          .where(eq(pulseDeletionJobs.profileId, profileId))
          .limit(1),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });
    const row = rows[0];
    if (!row) return { scheduled: false } as const;
    return {
      scheduled: true as const,
      scheduledFor: row.hardDeleteAt,
      softDeletedAt: row.softDeletedAt,
    };
  });

/**
 * Marks the enrollment-notify ARC callback as done.
 */
export const markEnrollmentNotifyDone = (
  profileId: string,
): Effect.Effect<void, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const now = Math.floor(Date.now() / 1_000);
    yield* Effect.tryPromise({
      try: () =>
        db
          .update(pulseDeletionJobs)
          .set({ enrollmentNotifyDoneAt: now })
          .where(eq(pulseDeletionJobs.profileId, profileId)),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });
  });

/**
 * Hard-delete sweeper for the Pulse-side leave-app jobs. Runs after the
 * 7-day grace window. **Purges the user's personal Pulse data here, not
 * at soft-delete time** — RSVPs, close-friends, comms, and `pulse_users`
 * are removed atomically with the deletion_jobs row in a single tx so
 * cancellation during the grace window is fully reversible.
 *
 * Hosted events stay until their own `hard_delete_at` is reached (the
 * 14-day public-cancellation window for audience commitment) — handled
 * by the separate `runEventCancellationSweep`.
 */
export const runHardDeleteSweep = (
  opts: { batchSize?: number; nowMs?: number } = {},
): Effect.Effect<{ purged: number }, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const batchSize = opts.batchSize ?? 100;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1_000);

    const ready = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            profileId: pulseDeletionJobs.profileId,
            accountId: pulseDeletionJobs.accountId,
          })
          .from(pulseDeletionJobs)
          .where(lte(pulseDeletionJobs.hardDeleteAt, nowSec))
          .limit(batchSize),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });

    let purged = 0;
    for (const row of ready) {
      yield* Effect.tryPromise({
        // Atomic batch (D1) / sequential (bun:sqlite). Personal-data purge (the
        // work that requestErasure deferred) — all pure writes.
        try: () =>
          commitBatch(db, [
            db.delete(eventRsvps).where(eq(eventRsvps.profileId, row.profileId)),
            db
              .delete(pulseCloseFriends)
              .where(
                or(
                  eq(pulseCloseFriends.profileId, row.profileId),
                  eq(pulseCloseFriends.friendId, row.profileId),
                ),
              ),
            db.delete(eventComms).where(eq(eventComms.sentByProfileId, row.profileId)),
            db.delete(pulseUsers).where(eq(pulseUsers.profileId, row.profileId)),
            // C-H1 (re-review): onboarding state is Pulse-scoped personal
            // data (interests, opt-ins) and must go with the leave. The
            // profileId→accountId cache row goes too — keeping it would
            // preserve the exact account↔profile correlation the P6
            // invariant exists to prevent.
            db
              .delete(pulseAccountOnboarding)
              .where(eq(pulseAccountOnboarding.accountId, row.accountId)),
            db
              .delete(pulseProfileAccounts)
              .where(eq(pulseProfileAccounts.profileId, row.profileId)),
            db.delete(pulseDeletionJobs).where(eq(pulseDeletionJobs.profileId, row.profileId)),
          ]),
        catch: (cause) => new PulseErasureDbError({ cause }),
      });
      yield* recordCompletion("hard", "sweeper");
      purged += 1;
    }
    return { purged };
  }).pipe(withPulseAccountDeletion("hard"));

/**
 * Sweeper for hosted events whose 14-day public-cancellation window has
 * elapsed. Hard-deletes the event row + cascade-deletes RSVPs/comms/lineup.
 */
export const runEventCancellationSweep = (
  opts: { batchSize?: number; nowMs?: number } = {},
): Effect.Effect<{ purged: number }, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const batchSize = opts.batchSize ?? 100;
    const nowSec = Math.floor((opts.nowMs ?? Date.now()) / 1_000);

    const ready = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ id: events.id })
          .from(events)
          .where(lte(events.hardDeleteAt, nowSec))
          .limit(batchSize),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });

    let purged = 0;
    for (const row of ready) {
      yield* Effect.tryPromise({
        // Atomic batch (D1) / sequential (bun:sqlite) — pure cascade deletes.
        try: () =>
          commitBatch(db, [
            db.delete(eventRsvps).where(eq(eventRsvps.eventId, row.id)),
            db.delete(eventComms).where(eq(eventComms.eventId, row.id)),
            db.delete(eventLineup).where(eq(eventLineup.eventId, row.id)),
            db.delete(events).where(eq(events.id, row.id)),
          ]),
        catch: (cause) => new PulseErasureDbError({ cause }),
      }).pipe(
        Effect.tapError(() => Effect.sync(() => metricPulseHostCancelledHardDelete("error"))),
      );
      metricPulseHostCancelledHardDelete("ok");
      purged += 1;
    }
    return { purged };
  });

/**
 * Direct hard-delete invoked by the ARC `/internal/account-deleted`
 * endpoint when osn-api fans out a full-account deletion. Differs from
 * `requestErasure` in that there is no grace window — osn-api already
 * enforced its own 7-day clock — and we DO hard-delete events
 * immediately (no audience-commitment window in this path because the
 * full account is going away regardless).
 *
 * Idempotent: re-calling for the same profileIds is a no-op.
 */
export const purgeAccount = (
  accountId: string,
  profileIds: string[],
): Effect.Effect<{ purged: number; alreadyProcessed: boolean }, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;

    // S-H1: replay-protection ledger. The first call for an accountId
    // commits the work + ledger row in one tx; subsequent calls find the
    // row and return a no-op response. This prevents a captured
    // `account:erase` ARC token from being replayed against arbitrary
    // accounts to nuke their Pulse data.
    const existing = yield* Effect.tryPromise({
      try: () =>
        db
          .select({ accountId: pulseAccountPurges.accountId })
          .from(pulseAccountPurges)
          .where(eq(pulseAccountPurges.accountId, accountId))
          .limit(1),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });
    if (existing[0]) {
      return { purged: 0, alreadyProcessed: true };
    }

    if (profileIds.length === 0) {
      // Empty profile list still records a ledger entry so a follow-up
      // call with an unexpected non-empty list can't sneak through.
      yield* Effect.tryPromise({
        try: () =>
          db.insert(pulseAccountPurges).values({
            accountId,
            processedAt: Math.floor(Date.now() / 1_000),
            profileCount: 0,
          }),
        catch: (cause) => new PulseErasureDbError({ cause }),
      });
      return { purged: 0, alreadyProcessed: false };
    }

    // Read hosted-event ids up front. D1 has no interactive transaction, so the
    // read-then-conditional-write is split: this select runs first, then every
    // write commits as one atomic batch below. The profile is being deleted, so
    // no new hosted events can appear between the read and the batch.
    const hostedEventIds = (yield* Effect.tryPromise({
      try: (): Promise<{ id: string }[]> =>
        db
          .select({ id: events.id })
          .from(events)
          .where(inArray(events.createdByProfileId, profileIds)) as Promise<{ id: string }[]>,
      catch: (cause) => new PulseErasureDbError({ cause }),
    })).map((r) => r.id);

    // P-W2: bulk DELETEs via inArray instead of looping per profile/event.
    // Three statements per child table regardless of profile count, which
    // keeps the batch's write-lock window bounded and well under
    // FANOUT_TIMEOUT_MS = 10s as the host-event count grows.
    yield* Effect.tryPromise({
      // Atomic batch (D1) / sequential (bun:sqlite). The replay-protection
      // ledger insert is the LAST statement so partial completion can't leave a
      // half-purged account marked as "done" (on D1 the whole batch rolls back).
      try: () =>
        commitBatch(db, [
          db.delete(eventRsvps).where(inArray(eventRsvps.profileId, profileIds)),
          db
            .delete(pulseCloseFriends)
            .where(
              or(
                inArray(pulseCloseFriends.profileId, profileIds),
                inArray(pulseCloseFriends.friendId, profileIds),
              ),
            ),
          db.delete(eventComms).where(inArray(eventComms.sentByProfileId, profileIds)),
          db.delete(pulseUsers).where(inArray(pulseUsers.profileId, profileIds)),

          // C-H1 (re-review): Pulse-scoped personal data added by the
          // onboarding feature — interests/opt-ins keyed by accountId, and
          // the profileId→accountId cache rows whose survival would
          // preserve the exact correlation the P6 invariant prevents.
          db.delete(pulseAccountOnboarding).where(eq(pulseAccountOnboarding.accountId, accountId)),
          db
            .delete(pulseProfileAccounts)
            .where(inArray(pulseProfileAccounts.profileId, profileIds)),

          // Drop hosted events + their cascading rows for the deleted profiles.
          ...(hostedEventIds.length > 0
            ? [
                db.delete(eventRsvps).where(inArray(eventRsvps.eventId, hostedEventIds)),
                db.delete(eventComms).where(inArray(eventComms.eventId, hostedEventIds)),
                db.delete(eventLineup).where(inArray(eventLineup.eventId, hostedEventIds)),
                db.delete(events).where(inArray(events.id, hostedEventIds)),
              ]
            : []),

          // Drop any in-flight Pulse leave-app jobs for these profiles.
          db.delete(pulseDeletionJobs).where(inArray(pulseDeletionJobs.profileId, profileIds)),

          // Replay-protection ledger entry — last, see note above.
          db.insert(pulseAccountPurges).values({
            accountId,
            processedAt: Math.floor(Date.now() / 1_000),
            profileCount: profileIds.length,
          }),
        ]),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });

    yield* recordCompletion("hard", "admin");
    return { purged: profileIds.length, alreadyProcessed: false };
  });

/**
 * Type alias for the row used by retry sweepers.
 */
export type PulseDeletionJobRow = Pick<
  PulseDeletionJob,
  "profileId" | "accountId" | "enrollmentNotifyDoneAt"
>;
