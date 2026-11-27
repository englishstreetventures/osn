/**
 * Sending a change notice to every account, one batch a call.
 *
 * The audience is every account created at or before the run started and not
 * under a processing restriction: active accounts and those inside their
 * deletion window, which can still restore. An erased account has no row, so
 * it is never mailed; one created after the start signed up under the page
 * already live.
 *
 * A run walks `accounts` in id order. Its row in `change_notice_runs` holds a
 * cursor, the last account a confirmed batch covered, and the batch in hand:
 * an idempotency key the mail provider dedupes on for 24 hours, the highest
 * account id the batch covers, and how many sends under the key were begun
 * and how many were refused. The rules that keep a run from skipping anyone or
 * mailing anyone twice:
 *
 * - The cursor passes an account only after the provider accepted a batch
 *   holding it (or refused its address on its own).
 * - A key is dropped without that only when every send under it was refused,
 *   which sends nothing. A send that timed out, failed in transit, got a 5xx or
 *   was cut off never counts as refused, so the next call sends the same batch
 *   under the same key, and the provider delivers it once.
 * - What cannot be known — the provider saying the key carried another payload,
 *   or a key older than the provider keeps it with a send not refused — is
 *   marked `unconfirmed` and left to the operator, who may send that batch
 *   again under a new key.
 *
 * Every write that moves the run names the state it read, so two calls at once
 * cannot both claim a batch or both move the cursor. No address is stored or
 * logged; logs carry the notice id, counts and the provider's status.
 */

import { accounts, changeNoticeRuns } from "@osn/db/schema";
import { Db } from "@osn/db/service";
import {
  type ChangeNoticeData,
  EmailError,
  EmailService,
  type SendEmailInput,
} from "@shared/email";
import { and, asc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import { Cause, Data, type Duration, Effect, Exit, Option } from "effect";

import { metricChangeNoticeBatch, metricChangeNoticeEmails } from "../metrics";

/** The most addresses one call sends: one provider batch. */
export const CHANGE_NOTICE_BATCH_LIMIT = 100;

/** A key older than this, with a send not refused, is past what the provider remembers: 23 h of its 24. */
export const CHANGE_NOTICE_KEY_STALE_SECONDS = 23 * 60 * 60;

export class ChangeNoticeDbError extends Data.TaggedError("ChangeNoticeDbError")<{
  readonly cause: unknown;
}> {}

/** What a dry run reports: counts only. */
export interface ChangeNoticeCounts {
  readonly finished: boolean;
  /** Accounts in the audience the run has not passed yet. */
  readonly toSend: number;
  /** Accounts left out because their processing is restricted. */
  readonly skipped: number;
  readonly sentSoFar: number;
  readonly failedSoFar: number;
  /** Addresses in a batch the route will not send again without the operator. */
  readonly unconfirmed: number;
}

/** What one call of the run did. */
export type ChangeNoticeBatchOutcome =
  | { readonly kind: "finished"; readonly sentSoFar: number; readonly failedSoFar: number }
  | {
      readonly kind: "sent";
      readonly sent: number;
      readonly failed: number;
      readonly sentSoFar: number;
      readonly failedSoFar: number;
    }
  | { readonly kind: "busy" }
  | { readonly kind: "unconfirmed"; readonly count: number }
  | { readonly kind: "pending_exceeds_limit"; readonly count: number }
  | { readonly kind: "rate_limited" }
  | { readonly kind: "refused" }
  | { readonly kind: "unknown" };

/** One call of the run. */
export interface ChangeNoticeBatchRequest {
  readonly noticeId: string;
  /** The template's data, one object for every recipient, so it renders once. */
  readonly data: ChangeNoticeData;
  /** The most addresses this call may send, 1 to {@link CHANGE_NOTICE_BATCH_LIMIT}. */
  readonly limit: number;
  /** Send an `unconfirmed` batch again under a new key: some in it may get the notice twice. */
  readonly resendUnconfirmed: boolean;
  /** Unix seconds. */
  readonly now: number;
  /** How long the provider call may take before its outcome counts as unknown. */
  readonly timeout: Duration.Input;
  /** A fresh idempotency key. */
  readonly newKey: () => string;
}

const query = <A>(run: () => Promise<A>): Effect.Effect<A, ChangeNoticeDbError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new ChangeNoticeDbError({ cause }) });

/**
 * How long before the run started an account must have been created to be in
 * its audience. A sign-up takes its `created_at` before it commits, so without
 * a margin an account could commit after a batch was claimed and fall inside
 * it. An account created in that minute signed up under the page already live.
 */
export const CHANGE_NOTICE_AUDIENCE_MARGIN_SECONDS = 60;

/** The latest `created_at` in the audience of a run that started at `startedAt`, as a Date. */
const audienceCutoff = (startedAt: number) =>
  new Date((startedAt - CHANGE_NOTICE_AUDIENCE_MARGIN_SECONDS) * 1_000);

/** The run's accounts: created a minute or more before it started, and not restricted. */
const inAudience = (startedAt: number) =>
  and(lte(accounts.createdAt, audienceCutoff(startedAt)), isNull(accounts.processingRestrictedAt));

const after = (cursor: string | null) => (cursor === null ? undefined : gt(accounts.id, cursor));

const cursorIs = (cursor: string | null) =>
  cursor === null ? isNull(changeNoticeRuns.cursor) : eq(changeNoticeRuns.cursor, cursor);

const CLEAR_PENDING = {
  pendingKey: null,
  pendingLast: null,
  pendingCount: null,
  pendingSince: null,
  pendingAttempts: null,
  pendingRefused: null,
  pendingState: null,
} as const;

/** Counts for a dry run. Reads only; writes nothing and sends nothing. */
export const changeNoticeCounts = (
  noticeId: string,
  now: number,
): Effect.Effect<ChangeNoticeCounts, ChangeNoticeDbError, Db> =>
  Effect.gen(function* () {
    const { db } = yield* Db;
    const [row] = yield* query(() =>
      db.select().from(changeNoticeRuns).where(eq(changeNoticeRuns.noticeId, noticeId)).limit(1),
    );
    const finished = row?.finishedAt !== null && row?.finishedAt !== undefined;
    const cursor = row?.cursor ?? null;
    const startedAt = row?.startedAt ?? now;
    const passed = cursor === null ? sql`0` : sql`${accounts.id} <= ${cursor}`;
    const [counts] = yield* query(() =>
      db
        .select({
          toSend:
            sql<number>`coalesce(sum(case when ${accounts.processingRestrictedAt} is null and not (${passed}) then 1 else 0 end), 0)`.mapWith(
              Number,
            ),
          skipped:
            sql<number>`coalesce(sum(case when ${accounts.processingRestrictedAt} is not null then 1 else 0 end), 0)`.mapWith(
              Number,
            ),
        })
        .from(accounts)
        .where(lte(accounts.createdAt, audienceCutoff(startedAt))),
    );
    const stale =
      row?.pendingKey != null &&
      now - (row.pendingSince ?? now) > CHANGE_NOTICE_KEY_STALE_SECONDS &&
      (row.pendingAttempts ?? 0) > (row.pendingRefused ?? 0);
    const unconfirmed =
      row?.pendingKey != null && (row.pendingState === "unconfirmed" || stale)
        ? (row.pendingCount ?? 0)
        : 0;
    return {
      finished,
      toSend: finished ? 0 : (counts?.toSend ?? 0),
      skipped: counts?.skipped ?? 0,
      sentSoFar: row?.sent ?? 0,
      failedSoFar: row?.failed ?? 0,
      unconfirmed,
    };
  }).pipe(
    Effect.withSpan("change_notice.dry_run", { attributes: { "change_notice.id": noticeId } }),
  );

/** How a provider answer moves the batch in hand. */
type Answer =
  | { readonly kind: "accepted"; readonly accepted: number; readonly refused: number }
  | { readonly kind: "unconfirmed"; readonly status: number }
  | { readonly kind: "busy"; readonly status: number }
  | { readonly kind: "rate_limited"; readonly status: number | undefined }
  | { readonly kind: "refused"; readonly status: number | undefined }
  | { readonly kind: "unknown"; readonly status: number | undefined };

/**
 * Reads the provider's answer. Every 409 keeps the key: a named
 * `invalid_idempotent_request` means the key carried another payload, which
 * may have gone; anything else (another send in flight, or a body that could
 * not be read) is busy. A 429, any other 4xx and a render failure sent
 * nothing. Everything else — a 5xx, a network error, a timeout, a defect —
 * may have sent, so the outcome is unknown.
 */
function readAnswer(
  exit: Exit.Exit<
    Option.Option<{ readonly accepted: number; readonly refused: number }>,
    EmailError
  >,
): Answer {
  if (Exit.isSuccess(exit)) {
    return Option.isSome(exit.value)
      ? { kind: "accepted", ...exit.value.value }
      : { kind: "unknown", status: undefined };
  }
  const failure = Cause.findErrorOption(exit.cause);
  if (Option.isNone(failure)) return { kind: "unknown", status: undefined };
  const error = failure.value;
  if (error.status === 409) {
    return error.providerError === "invalid_idempotent_request"
      ? { kind: "unconfirmed", status: 409 }
      : { kind: "busy", status: 409 };
  }
  if (error.reason === "rate_limited" || error.status === 429) {
    return { kind: "rate_limited", status: error.status };
  }
  if (error.reason === "render_failed") return { kind: "refused", status: undefined };
  if (error.status !== undefined && error.status >= 400 && error.status < 500) {
    return { kind: "refused", status: error.status };
  }
  // A keyed batch over the limit fails before any request, with no status.
  if (error.reason === "dispatch_failed" && error.status === undefined) {
    return { kind: "refused", status: undefined };
  }
  return { kind: "unknown", status: error.status };
}

/**
 * One call of the run: claims the next batch, or takes up the batch in hand,
 * sends it under its key, and moves the run by what the provider answered.
 */
export const sendChangeNoticeBatch = (
  request: ChangeNoticeBatchRequest,
): Effect.Effect<ChangeNoticeBatchOutcome, ChangeNoticeDbError, Db | EmailService> =>
  Effect.gen(function* () {
    const { noticeId, now, limit } = request;
    const { db } = yield* Db;
    const mailer = yield* EmailService;
    const send = mailer.sendKeyedBatch;
    if (send === undefined) return { kind: "refused" } as const;
    const ofNotice = eq(changeNoticeRuns.noticeId, noticeId);

    const [row] = yield* query(() =>
      db
        .insert(changeNoticeRuns)
        .values({ noticeId, startedAt: now })
        .onConflictDoUpdate({
          target: changeNoticeRuns.noticeId,
          set: { noticeId: sql`excluded.notice_id` },
        })
        .returning(),
    );
    if (row === undefined) return yield* Effect.die("the run's row was neither written nor read");
    if (row.finishedAt !== null) {
      return { kind: "finished", sentSoFar: row.sent, failedSoFar: row.failed } as const;
    }

    let key: string;
    let last: string;
    let count: number;
    let recipients: ReadonlyArray<{ readonly id: string; readonly email: string }>;
    // This call sends an unconfirmed batch again under a new key, as the
    // operator asked: it takes the batch's range as it now stands.
    let resending = false;

    const inHand = row.pendingKey;
    if (inHand !== null) {
      // The batch in hand: never more than this call may send.
      count = row.pendingCount ?? 0;
      if (count > limit) return { kind: "pending_exceeds_limit", count } as const;
      const stale =
        now - (row.pendingSince ?? now) > CHANGE_NOTICE_KEY_STALE_SECONDS &&
        (row.pendingAttempts ?? 0) > (row.pendingRefused ?? 0);
      if (row.pendingState === "unconfirmed" || stale) {
        // Marked only when the operator has not asked to send it again: a
        // re-key below overwrites the mark in the same call.
        if (row.pendingState !== "unconfirmed" && !request.resendUnconfirmed) {
          const marked = yield* query(() =>
            db
              .update(changeNoticeRuns)
              .set({ pendingState: "unconfirmed" })
              .where(and(ofNotice, eq(changeNoticeRuns.pendingKey, inHand)))
              .returning({ noticeId: changeNoticeRuns.noticeId }),
          );
          // Another call moved the batch on: nothing is left to confirm.
          if (marked.length === 0) return { kind: "busy" } as const;
        }
        if (!request.resendUnconfirmed) {
          metricChangeNoticeBatch("unconfirmed");
          yield* Effect.logWarning("change notice batch unconfirmed").pipe(
            Effect.annotateLogs({ notice_id: noticeId, result: "unconfirmed", count }),
          );
          return { kind: "unconfirmed", count } as const;
        }
        const fresh = request.newKey();
        const rekeyed = yield* query(() =>
          db
            .update(changeNoticeRuns)
            .set({
              pendingKey: fresh,
              pendingSince: now,
              pendingAttempts: 1,
              pendingRefused: 0,
              pendingState: "open",
            })
            .where(and(ofNotice, eq(changeNoticeRuns.pendingKey, inHand)))
            .returning({ noticeId: changeNoticeRuns.noticeId }),
        );
        if (rekeyed.length === 0) return { kind: "busy" } as const;
        resending = true;
        yield* Effect.logWarning("change notice batch sent again under a new key").pipe(
          Effect.annotateLogs({ notice_id: noticeId, count }),
        );
        key = fresh;
      } else {
        const bumped = yield* query(() =>
          db
            .update(changeNoticeRuns)
            .set({ pendingAttempts: sql`${changeNoticeRuns.pendingAttempts} + 1` })
            .where(
              and(
                ofNotice,
                eq(changeNoticeRuns.pendingKey, inHand),
                eq(changeNoticeRuns.pendingAttempts, row.pendingAttempts ?? 0),
              ),
            )
            .returning({ noticeId: changeNoticeRuns.noticeId }),
        );
        if (bumped.length === 0) return { kind: "busy" } as const;
        key = inHand;
      }
      last = row.pendingLast ?? "";
      const pendingLast = last;
      // The batch as claimed, less any account erased or restricted since.
      // No account should join it (the audience margin above); one more row
      // than the batch held means one did, and the route cannot tell which
      // address was in the batch the provider may have taken, so it will not
      // guess.
      recipients = yield* query(() =>
        db
          .select({ id: accounts.id, email: accounts.email })
          .from(accounts)
          .where(and(after(row.cursor), lte(accounts.id, pendingLast), inAudience(row.startedAt)))
          .orderBy(asc(accounts.id))
          .limit(resending ? CHANGE_NOTICE_BATCH_LIMIT : count + 1),
      );
      if (!resending && recipients.length > count) {
        const marked = yield* query(() =>
          db
            .update(changeNoticeRuns)
            .set({ pendingState: "unconfirmed" })
            .where(and(ofNotice, eq(changeNoticeRuns.pendingKey, key)))
            .returning({ noticeId: changeNoticeRuns.noticeId }),
        );
        if (marked.length === 0) return { kind: "busy" } as const;
        metricChangeNoticeBatch("unconfirmed");
        yield* Effect.logWarning("change notice batch unconfirmed").pipe(
          Effect.annotateLogs({ notice_id: noticeId, result: "grew", count }),
        );
        return { kind: "unconfirmed", count } as const;
      }
    } else {
      recipients = yield* query(() =>
        db
          .select({ id: accounts.id, email: accounts.email })
          .from(accounts)
          .where(and(after(row.cursor), inAudience(row.startedAt)))
          .orderBy(asc(accounts.id))
          .limit(limit),
      );
      const newest = recipients.at(-1);
      if (newest === undefined) {
        const done = yield* query(() =>
          db
            .update(changeNoticeRuns)
            .set({ finishedAt: now, cursor: null })
            .where(
              and(
                ofNotice,
                isNull(changeNoticeRuns.pendingKey),
                isNull(changeNoticeRuns.finishedAt),
                cursorIs(row.cursor),
              ),
            )
            .returning({ sent: changeNoticeRuns.sent, failed: changeNoticeRuns.failed }),
        );
        const counts = done[0];
        if (counts === undefined) return { kind: "busy" } as const;
        yield* Effect.logInfo("change notice run finished").pipe(
          Effect.annotateLogs({
            notice_id: noticeId,
            sent_total: counts.sent,
            failed_total: counts.failed,
          }),
        );
        return { kind: "finished", sentSoFar: counts.sent, failedSoFar: counts.failed } as const;
      }
      key = request.newKey();
      last = newest.id;
      count = recipients.length;
      const claimed = yield* query(() =>
        db
          .update(changeNoticeRuns)
          .set({
            pendingKey: key,
            pendingLast: last,
            pendingCount: count,
            pendingSince: now,
            pendingAttempts: 1,
            pendingRefused: 0,
            pendingState: "open",
          })
          .where(
            and(
              ofNotice,
              isNull(changeNoticeRuns.pendingKey),
              isNull(changeNoticeRuns.finishedAt),
              cursorIs(row.cursor),
            ),
          )
          .returning({ noticeId: changeNoticeRuns.noticeId }),
      );
      if (claimed.length === 0) return { kind: "busy" } as const;
    }

    const advance = (accepted: number, refused: number) =>
      query(() =>
        db
          .update(changeNoticeRuns)
          .set({
            cursor: last,
            sent: sql`${changeNoticeRuns.sent} + ${accepted}`,
            failed: sql`${changeNoticeRuns.failed} + ${refused}`,
            ...CLEAR_PENDING,
          })
          .where(and(ofNotice, eq(changeNoticeRuns.pendingKey, key)))
          .returning({ sent: changeNoticeRuns.sent, failed: changeNoticeRuns.failed }),
      );

    if (recipients.length === 0) {
      // Every account in the batch was erased or restricted since it was claimed.
      const moved = yield* advance(0, 0);
      const counts = moved[0];
      return counts === undefined
        ? ({ kind: "busy" } as const)
        : ({
            kind: "sent",
            sent: 0,
            failed: 0,
            sentSoFar: counts.sent,
            failedSoFar: counts.failed,
          } as const);
    }

    const inputs: SendEmailInput[] = recipients.map((recipient) => ({
      template: "change-notice",
      to: recipient.email,
      data: request.data,
    }));
    const answer = readAnswer(
      yield* Effect.exit(
        send(inputs, { idempotencyKey: key }).pipe(Effect.timeoutOption(request.timeout)),
      ),
    );

    if (answer.kind === "accepted") {
      const moved = yield* advance(answer.accepted, answer.refused);
      const counts = moved[0];
      // Another call moved the run past this batch first, or the key was
      // replaced: nothing is counted twice.
      if (counts === undefined) return { kind: "busy" } as const;
      metricChangeNoticeBatch("sent");
      metricChangeNoticeEmails(answer.accepted, answer.refused);
      yield* Effect.logInfo("change notice batch sent").pipe(
        Effect.annotateLogs({
          notice_id: noticeId,
          accepted: answer.accepted,
          refused: answer.refused,
          sent_total: counts.sent,
        }),
      );
      return {
        kind: "sent",
        sent: answer.accepted,
        failed: answer.refused,
        sentSoFar: counts.sent,
        failedSoFar: counts.failed,
      } as const;
    }

    metricChangeNoticeBatch(answer.kind);
    yield* Effect.logWarning("change notice batch not sent").pipe(
      Effect.annotateLogs({
        notice_id: noticeId,
        result: answer.kind,
        status: answer.status ?? "none",
      }),
    );

    if (answer.kind === "unconfirmed") {
      const marked = yield* query(() =>
        db
          .update(changeNoticeRuns)
          .set({ pendingState: "unconfirmed" })
          .where(and(ofNotice, eq(changeNoticeRuns.pendingKey, key)))
          .returning({ noticeId: changeNoticeRuns.noticeId }),
      );
      return marked.length === 0
        ? ({ kind: "busy" } as const)
        : ({ kind: "unconfirmed", count } as const);
    }
    if (answer.kind === "rate_limited" || answer.kind === "refused") {
      // Counted refused, in one statement that also drops the batch when
      // every send under its key was refused: then nothing under it went.
      // SQLite evaluates each SET against the row as it stood.
      const allRefused = sql`${changeNoticeRuns.pendingRefused} + 1 = ${changeNoticeRuns.pendingAttempts}`;
      const unlessAllRefused = (column: SQLiteColumn) =>
        sql`CASE WHEN ${allRefused} THEN NULL ELSE ${column} END`;
      yield* query(() =>
        db
          .update(changeNoticeRuns)
          .set({
            pendingRefused: sql`CASE WHEN ${allRefused} THEN NULL ELSE ${changeNoticeRuns.pendingRefused} + 1 END`,
            pendingKey: unlessAllRefused(changeNoticeRuns.pendingKey),
            pendingLast: unlessAllRefused(changeNoticeRuns.pendingLast),
            pendingCount: unlessAllRefused(changeNoticeRuns.pendingCount),
            pendingSince: unlessAllRefused(changeNoticeRuns.pendingSince),
            pendingAttempts: unlessAllRefused(changeNoticeRuns.pendingAttempts),
            pendingState: unlessAllRefused(changeNoticeRuns.pendingState),
          })
          .where(and(ofNotice, eq(changeNoticeRuns.pendingKey, key))),
      );
      return { kind: answer.kind } as const;
    }
    return { kind: answer.kind } as const;
  }).pipe(
    Effect.withSpan("change_notice.send", { attributes: { "change_notice.id": request.noticeId } }),
  );
