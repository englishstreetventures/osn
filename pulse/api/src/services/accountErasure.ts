import {
  events,
  eventComms,
  eventLineup,
  eventRsvps,
  eventSeries,
  pulseAccountOnboarding,
  pulseAccountPurges,
  pulseCloseFriends,
  pulseDeletionJobs,
  pulseProfileAccounts,
  pulseUsers,
  pulseWebSessions,
} from "@pulse/db/schema";
import { Db } from "@pulse/db/service";
import { commitBatch, jsonEachIn, rowsChanged } from "@shared/db-utils";
import type {
  DeletionCompletedResult,
  DeletionCompletedSource,
} from "@shared/observability/metrics";
import {
  and,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
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
 *      `hard_delete_at` (14 days after the leave) has passed.
 *   5. `purgeAccount` — endpoint hit by osn-api's full-account-delete
 *      fan-out, with the person's answers. No grace of its own: OSN already
 *      enforced its 7-day window. Each upcoming hosted event is cancelled and
 *      kept 14 days for its guests, or deleted at once, as answered.
 *   6. `previewDeletion` — what an account deletion would leave open here:
 *      the upcoming events the person hosts, each with its two choices.
 *   7. `revokeWebSessions` — ends the person's Pulse web sessions when their
 *      OSN account's deletion is requested.
 */

const PULSE_LEAVE_GRACE_SECONDS = 7 * 24 * 60 * 60;
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

interface RequestErasureInput {
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
 *     (this is reversible too — `cancelErasure` un-cancels them), and gives
 *     the host's own cancelled events the same `hard_delete_at`
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
          // One pass over the host's events that aren't finished:
          //   - one not yet cancelled is cancelled because the host left;
          //     `cancelledAt` is now and the reason `host_left`;
          //   - one the host had already cancelled themselves keeps its
          //     status, reason and `cancelledAt`;
          //   - both get the 14-day hard-delete date. The event-cancellation
          //     sweeper deletes them when it passes; `cancelErasure`
          //     unschedules them before then.
          // A cancelled event that already has a date is left alone. Status
          // stays "cancelled" on every matched row, so the status-aware UI
          // surfaces the right copy without reading `cancelled_at`. SQLite
          // evaluates every SET expression against the row before the update,
          // so each CASE sees the original status.
          db
            .update(events)
            .set({
              cancelledAt: sql`CASE WHEN ${events.status} = 'cancelled' THEN ${events.cancelledAt} ELSE ${now} END`,
              cancellationReason: sql`CASE WHEN ${events.status} = 'cancelled' THEN ${events.cancellationReason} ELSE 'host_left' END`,
              hardDeleteAt: eventCancelHardDeleteAt,
              status: "cancelled",
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(events.createdByProfileId, profileId),
                ne(events.status, "finished"),
                or(ne(events.status, "cancelled"), isNull(events.hardDeleteAt)),
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

    yield* Effect.tryPromise({
      // Atomic batch (D1) / sequential (bun:sqlite) — pure writes, no read.
      try: () =>
        commitBatch(db, [
          // Every hosted event the leave scheduled for hard delete is
          // unscheduled, whatever its status, while the leave's job still
          // stands. The leave and the account erasure both set
          // `hardDeleteAt`, the column the sweeper deletes by; the erasure
          // deletes the leave's job in the batch that sets it, so an event
          // the erasure keeps for its guests is never unscheduled here. This
          // runs before the job delete below, which its check reads. One the
          // leave cancelled (`host_left`) is restored to `upcoming` — the next
          // read derives its real status from its times. One the organiser
          // cancelled, before the leave or since (a series cancel takes a
          // host-left instance over), stays cancelled. SQLite evaluates every
          // SET expression against the row before the update, so each CASE
          // sees the original reason.
          db
            .update(events)
            .set({
              status: sql`CASE WHEN ${events.cancellationReason} = 'host_left' THEN 'upcoming' ELSE ${events.status} END`,
              cancelledAt: sql`CASE WHEN ${events.cancellationReason} = 'host_left' THEN NULL ELSE ${events.cancelledAt} END`,
              cancellationReason: sql`CASE WHEN ${events.cancellationReason} = 'host_left' THEN NULL ELSE ${events.cancellationReason} END`,
              hardDeleteAt: null,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(events.createdByProfileId, profileId),
                isNotNull(events.hardDeleteAt),
                exists(
                  db
                    .select({ one: sql`1` })
                    .from(pulseDeletionJobs)
                    .where(eq(pulseDeletionJobs.profileId, profileId)),
                ),
              ),
            ),
          db.delete(pulseDeletionJobs).where(eq(pulseDeletionJobs.profileId, profileId)),
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
            // Onboarding state is Pulse-scoped personal
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

// ---------------------------------------------------------------------------
// Full account deletion (osn-api's fan-out)
// ---------------------------------------------------------------------------

/** One thing an account deletion leaves open here, in the contract's field names. */
export interface DeletionOpenAction {
  readonly id: string;
  readonly kind: "events_hosted";
  readonly label: string;
  readonly choices: ReadonlyArray<{
    readonly choice: "cancel" | "delete";
    readonly description: string;
    readonly erasedOn: number | null;
  }>;
  readonly defaultChoice: "cancel";
  readonly link: null;
}

/** One thing this app keeps after the account is gone. */
export interface KeptItem {
  readonly what: string;
  readonly erasedOn: number | null;
  readonly requestUrl: string | null;
}

/** The person's answers, by action id, as osn-api sends them. */
export type DeletionAnswers = Readonly<Record<string, { readonly choice: string }>>;

/** Most actions one preview lists before it folds every event into one. */
const MAX_PREVIEW_ACTIONS = 100;

/** Longest event or series title a label quotes. */
const MAX_TITLE_IN_LABEL = 200;

const quoted = (title: string): string =>
  `"${title.length > MAX_TITLE_IN_LABEL ? `${title.slice(0, MAX_TITLE_IN_LABEL)}…` : title}"`;

const dayOf = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The upcoming events `profileIds` host, not finished and not cancelled, as
 * the preview lists them: one row per series (at its soonest instance, with
 * its count) and one per other event, soonest first, at most
 * {@link MAX_PREVIEW_ACTIONS} + 1 rows whatever the host holds. Each row also
 * carries how many such rows there are in all and how many events.
 */
const upcomingHostedGroups = (profileIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const firstStart = sql<Date>`min(${events.startTime})`.mapWith(events.startTime);
    return yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            id: sql<string>`coalesce(${events.seriesId}, ${events.id})`,
            seriesId: events.seriesId,
            title: sql<string>`CASE WHEN ${events.seriesId} IS NULL THEN ${events.title} ELSE coalesce(${eventSeries.title}, ${events.title}) END`,
            firstStart,
            count: sql<number>`count(*)`,
            groups: sql<number>`count(*) OVER ()`,
            total: sql<number>`sum(count(*)) OVER ()`,
          })
          .from(events)
          .leftJoin(eventSeries, eq(eventSeries.id, events.seriesId))
          .where(
            and(
              inArray(events.createdByProfileId, jsonEachIn(profileIds)),
              notInArray(events.status, ["finished", "cancelled"]),
            ),
          )
          .groupBy(sql`coalesce(${events.seriesId}, ${events.id})`)
          .orderBy(sql`min(${events.startTime})`, sql`coalesce(${events.seriesId}, ${events.id})`)
          .limit(MAX_PREVIEW_ACTIONS + 1),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });
  });

const choicesFor = (deletesAt: number): DeletionOpenAction["choices"] => [
  {
    choice: "cancel",
    description:
      "Cancelled when your account is deleted. Its guests see it as cancelled for 14 days; then it is deleted.",
    erasedOn: deletesAt + EVENT_CANCELLATION_WINDOW_SECONDS,
  },
  {
    choice: "delete",
    description: "Deleted when your account is deleted, with its guest list and messages.",
    erasedOn: null,
  },
];

/**
 * What deleting the account of `profileIds` would leave open in Pulse, if the
 * fan-out reaches Pulse at `deletesAt` (unix seconds): one action per series
 * with upcoming events and one per other upcoming event the person hosts,
 * soonest first. Past {@link MAX_PREVIEW_ACTIONS} actions, one action,
 * `pulse:events:all`, stands for every upcoming event they host. Every action
 * has the existing 14-day cancellation as its default.
 */
export const previewDeletion = (
  profileIds: ReadonlyArray<string>,
  deletesAt: number,
): Effect.Effect<ReadonlyArray<DeletionOpenAction>, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    if (profileIds.length === 0) return [];
    const groups = yield* upcomingHostedGroups(profileIds);
    const choices = choicesFor(deletesAt);
    const action = (id: string, label: string): DeletionOpenAction => ({
      id,
      kind: "events_hosted",
      label,
      choices,
      defaultChoice: "cancel",
      link: null,
    });
    const first = groups[0];
    if (!first) return [];
    if (first.groups > MAX_PREVIEW_ACTIONS) {
      return [action("pulse:events:all", `You host ${first.total} upcoming events.`)];
    }
    return groups.map((group) =>
      group.seriesId === null
        ? action(
            `pulse:event:${group.id}`,
            `You host ${quoted(group.title)}, starting ${dayOf(group.firstStart)}.`,
          )
        : action(
            `pulse:series:${group.seriesId}`,
            `You host ${group.count} upcoming event${group.count === 1 ? "" : "s"} of ${quoted(group.title)}.`,
          ),
    );
  }).pipe(Effect.withSpan("pulse.account_erasure.preview"));

/**
 * The choice that applies to one hosted event: its own answer, else its
 * series', else the answer for all events, else the default, `cancel`.
 * Anything but `delete` keeps the event for its guests.
 */
const choiceOf = (
  answers: DeletionAnswers,
  event: { readonly id: string; readonly seriesId: string | null },
): "cancel" | "delete" => {
  const answer =
    answers[`pulse:event:${event.id}`] ??
    (event.seriesId === null ? undefined : answers[`pulse:series:${event.seriesId}`]) ??
    answers["pulse:events:all"];
  return answer?.choice === "delete" ? "delete" : "cancel";
};

/**
 * What Pulse keeps of `profileIds` hosting, from the rows as they stand: the
 * events the erasure cancelled and keeps for their guests (each has a
 * `hard_delete_at`), as one item with the latest date one of them is deleted.
 */
const keptOf = (profileIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* Effect.tryPromise({
      try: () =>
        db
          .select({
            count: sql<number>`count(*)`,
            until: sql<number | null>`max(${events.hardDeleteAt})`,
          })
          .from(events)
          .where(
            and(
              inArray(events.createdByProfileId, jsonEachIn(profileIds)),
              isNotNull(events.hardDeleteAt),
            ),
          ),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });
    return keptItems(row?.count ?? 0, row?.until ?? null);
  });

const keptItems = (count: number, until: number | null): ReadonlyArray<KeptItem> =>
  count > 0 && until !== null
    ? [
        {
          what: `${count} event${count === 1 ? "" : "s"} you hosted, shown to ${count === 1 ? "its" : "their"} guests as cancelled`,
          erasedOn: until,
          requestUrl: null,
        },
      ]
    : [];

/** What an erasure of one account answers osn-api. */
export interface PurgeAccountResult {
  readonly purged: number;
  readonly alreadyProcessed: boolean;
  /** What Pulse keeps: the hosted events kept for their guests, as one item. */
  readonly kept: ReadonlyArray<KeptItem>;
}

/**
 * Erases an account's Pulse data when osn-api's fan-out reaches Pulse, at the
 * end of the account's 7-day window, with the person's `answers`.
 *
 * Each upcoming event the person hosts takes its answer ({@link choiceOf}):
 * `cancel`, the default, cancels it (`host_left`) and keeps it 14 days for its
 * guests, out of its series; `delete` deletes it at once with its RSVPs,
 * messages and lineup. Under `deleteEverything` every hosted event is deleted.
 * Finished and cancelled events, the person's series, RSVPs, close friends,
 * messages sent, Pulse profile, onboarding, profile-to-account rows, Pulse
 * leave jobs and web sessions are deleted. The ledger and the hosted events
 * are read together, then one batch writes, the ledger row last, so a batch
 * that fails leaves nothing marked done.
 *
 * Each write checks the event's state when it runs: an event read as
 * upcoming that a guest's visit has since marked finished is deleted, not
 * kept, and one cancelled since keeps that cancellation. The kept list is
 * read back from the events as written.
 *
 * Idempotent: a repeat for the same account, or a second call that overlaps
 * the first, writes nothing more and answers what Pulse keeps, read from the
 * kept events still standing.
 */
export const purgeAccount = (
  accountId: string,
  profileIds: ReadonlyArray<string>,
  options: { readonly answers?: DeletionAnswers; readonly deleteEverything?: boolean } = {},
): Effect.Effect<PurgeAccountResult, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const answers = options.answers ?? {};

    // Replay-protection ledger, read with the hosted events. The first call
    // for an accountId commits the work and the ledger row in one batch;
    // later calls find the row and write nothing. D1 has no interactive
    // transaction, so which events stay for their guests and which go is
    // decided from this read, and each write below checks it again when it
    // runs; the account is tombstoned, so no event is created in between.
    const [existing, hosted] = yield* Effect.all(
      [
        Effect.tryPromise({
          try: () =>
            db
              .select({ accountId: pulseAccountPurges.accountId })
              .from(pulseAccountPurges)
              .where(eq(pulseAccountPurges.accountId, accountId))
              .limit(1),
          catch: (cause) => new PulseErasureDbError({ cause }),
        }),
        profileIds.length === 0
          ? Effect.succeed([])
          : Effect.tryPromise({
              try: () =>
                db
                  .select({ id: events.id, status: events.status, seriesId: events.seriesId })
                  .from(events)
                  .where(inArray(events.createdByProfileId, jsonEachIn(profileIds))),
              catch: (cause) => new PulseErasureDbError({ cause }),
            }),
      ],
      { concurrency: "unbounded" },
    );
    if (existing[0]) {
      const kept = profileIds.length === 0 ? [] : yield* keptOf(profileIds);
      return { purged: 0, alreadyProcessed: true, kept };
    }

    const ledger = (processedAt: number) =>
      db
        .insert(pulseAccountPurges)
        .values({ accountId, processedAt, profileCount: profileIds.length })
        .onConflictDoNothing({ target: pulseAccountPurges.accountId });

    if (profileIds.length === 0) {
      // Empty profile list still records a ledger entry so a follow-up
      // call with an unexpected non-empty list can't sneak through.
      yield* Effect.tryPromise({
        try: () => ledger(Math.floor(Date.now() / 1_000)),
        catch: (cause) => new PulseErasureDbError({ cause }),
      });
      return { purged: 0, alreadyProcessed: false, kept: [] };
    }

    const keptIds: string[] = [];
    const deletedIds: string[] = [];
    for (const event of hosted) {
      const keep =
        !options.deleteEverything &&
        event.status !== "finished" &&
        event.status !== "cancelled" &&
        choiceOf(answers, event) === "cancel";
      (keep ? keptIds : deletedIds).push(event.id);
    }
    const now = Math.floor(Date.now() / 1_000);
    const keepUntil = now + EVENT_CANCELLATION_WINDOW_SECONDS;

    // The events that go now: those read to go, and any read to stay that a
    // guest's visit has marked finished since. Each statement checks it when
    // it runs. Bound as one JSON parameter each, whatever the count (D1 takes
    // at most 100 parameters a statement).
    const goes = or(
      inArray(events.id, jsonEachIn(deletedIds)),
      and(inArray(events.id, jsonEachIn(keptIds)), eq(events.status, "finished")),
    );
    const going = db.select({ id: events.id }).from(events).where(goes);

    yield* Effect.tryPromise({
      // Atomic batch (D1) / sequential (bun:sqlite). The replay-protection
      // ledger insert is the LAST statement so partial completion can't leave a
      // half-purged account marked as "done" (on D1 the whole batch rolls back).
      try: () =>
        commitBatch(db, [
          // The events that go, each with its RSVPs, messages and lineup.
          db.delete(eventRsvps).where(inArray(eventRsvps.eventId, going)),
          db.delete(eventComms).where(inArray(eventComms.eventId, going)),
          db.delete(eventLineup).where(inArray(eventLineup.eventId, going)),
          db.delete(events).where(goes),
          // Kept for their guests: cancelled because the host left, deleted
          // by the event-cancellation sweep 14 days on, and out of the
          // series, which goes below. Only while still upcoming: one
          // cancelled since keeps its own cancellation.
          db
            .update(events)
            .set({
              status: "cancelled",
              cancelledAt: now,
              cancellationReason: "host_left",
              hardDeleteAt: keepUntil,
              seriesId: null,
              updatedAt: new Date(now * 1_000),
            })
            .where(
              and(
                inArray(events.id, jsonEachIn(keptIds)),
                notInArray(events.status, ["finished", "cancelled"]),
              ),
            ),
          // The person's series: every instance is gone or out of it by now.
          db
            .delete(eventSeries)
            .where(inArray(eventSeries.createdByProfileId, jsonEachIn(profileIds))),
          db.delete(eventRsvps).where(inArray(eventRsvps.profileId, jsonEachIn(profileIds))),
          db
            .delete(pulseCloseFriends)
            .where(
              or(
                inArray(pulseCloseFriends.profileId, jsonEachIn(profileIds)),
                inArray(pulseCloseFriends.friendId, jsonEachIn(profileIds)),
              ),
            ),
          db.delete(eventComms).where(inArray(eventComms.sentByProfileId, jsonEachIn(profileIds))),
          db.delete(pulseUsers).where(inArray(pulseUsers.profileId, jsonEachIn(profileIds))),

          // Pulse-scoped personal data added by the onboarding feature —
          // interests and opt-ins keyed by accountId, and the
          // profileId→accountId cache rows whose survival would preserve the
          // exact correlation the P6 invariant prevents.
          db.delete(pulseAccountOnboarding).where(eq(pulseAccountOnboarding.accountId, accountId)),
          db
            .delete(pulseProfileAccounts)
            .where(inArray(pulseProfileAccounts.profileId, jsonEachIn(profileIds))),

          // Any in-flight Pulse leave-app jobs, and every web session: the
          // soft delete ended them too, best effort.
          db
            .delete(pulseDeletionJobs)
            .where(inArray(pulseDeletionJobs.profileId, jsonEachIn(profileIds))),
          db
            .delete(pulseWebSessions)
            .where(inArray(pulseWebSessions.osnProfileId, jsonEachIn(profileIds))),

          // Replay-protection ledger entry — last, see note above. A second
          // call that overlapped this one finds the row written and writes
          // nothing.
          ledger(now),
        ]),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });

    yield* recordCompletion("hard", "admin");
    return {
      purged: profileIds.length,
      alreadyProcessed: false,
      kept: yield* keptOf(profileIds),
    };
  }).pipe(Effect.withSpan("pulse.account_erasure.purge"));

/**
 * Ends every Pulse web session of `profileIds`: called when the person's OSN
 * account deletion is requested, so no browser stays signed in to Pulse
 * through the window. Answers how many ended.
 */
export const revokeWebSessions = (
  profileIds: ReadonlyArray<string>,
): Effect.Effect<number, PulseErasureDbError, Db> =>
  Effect.gen(function* () {
    if (profileIds.length === 0) return 0;
    const { db } = yield* Db;
    const result = yield* Effect.tryPromise({
      try: () =>
        db
          .delete(pulseWebSessions)
          .where(inArray(pulseWebSessions.osnProfileId, jsonEachIn(profileIds))),
      catch: (cause) => new PulseErasureDbError({ cause }),
    });
    return rowsChanged(result);
  }).pipe(Effect.withSpan("pulse.account_erasure.revoke_sessions"));
