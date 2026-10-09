import {
  events,
  families,
  guestEvents,
  guests,
  imports,
  registryClaims,
  registryContributions,
  registrySettings,
  rsvps,
  weddingHosts,
  weddings,
} from "@cire/db";
import { jsonEachIn, rowsChanged } from "@shared/db-utils";
import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Cause, Data, Effect } from "effect";

import {
  commitBatchResults,
  DbService,
  dbQuery,
  MAX_STATEMENTS_PER_BATCH,
  outerColumn,
} from "../db";
import { weddingIsLive } from "../db/live-wedding";
import {
  metricGiftSummaryUnmailed,
  metricGiftSummaryWritten,
  metricGuestDataSwept,
} from "../metrics";
import type { DeletableBucket } from "./r2-cleanup";
import { reapR2Objects } from "./r2-cleanup";
import { decodeGiftSummary } from "./registry";

/**
 * R2 bindings the retention sweep reaps into. Optional — a deployment missing
 * the binding (local dev / misconfig) still purges the D1 rows; the orphaned
 * objects are logged + counted as errors by {@link reapR2Objects}.
 *
 *  - `sheets` — the `cire-sheets` bucket (binding `SHEETS`): every object an
 *    `imports` row names — the uploaded sheets (`events_r2_key` /
 *    `guests_r2_key`) and an applied change's before-image
 *    (`before_events_r2_key` / `before_guests_r2_key`). The sweep deletes the
 *    `imports` rows, so these objects ARE orphaned by it and must be reaped
 *    here; `sheet-reconcile.ts` reaps any whose delete fails.
 *
 * NOTE — the `cire-assets` invite images (`wedding_invite_customisations`'
 * per-slot image keys + `events.event_image_key`) are deliberately NOT reaped here:
 * the retention sweep KEEPS the wedding + events shell + the published invite,
 * so those rows survive and keep pointing at their objects (the invite stays
 * live). Deleting them would 404 the live invite and dangle the DB keys. A whole
 * wedding's images go when its owners delete it: the daily purge
 * (`maintenanceSweeps.purgeDeletedWeddings`) reaps both buckets with
 * {@link reapR2Objects}, and `asset-reconcile.ts` reaps whatever a failed
 * best-effort delete leaves behind.
 */
export interface RetentionBuckets {
  sheets?: DeletableBucket;
}

export class RetentionWriteError extends Data.TaggedError("RetentionWriteError")<{
  op: "sweep";
  reason: string;
}> {}

/**
 * Guest-data retention window. cire's published privacy notice
 * (`cire/invites/src/pages/privacy.astro`) promises guest data is deleted **1 year
 * after the final wedding event**. This constant encodes that window; change it
 * here (and the notice copy) to move the line. 365 days in milliseconds.
 */
export const RETENTION_AFTER_FINAL_EVENT_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Most weddings one sweep will take. The cohort is every wedding whose last
 * event passed a year ago and that still holds something the sweep deletes —
 * a household or an import. After a run of failed crons, or a busy season a
 * year later, it can be arbitrarily large.
 *
 * The cap bounds work, not bound parameters. D1 allows 100 per statement
 * (wiki/shared/d1-limits.md), fewer than this cohort or its households, so
 * every id list below rides as ONE `json_each` parameter (`jsonEachIn`); an
 * `IN (...)` binding each id would throw past 100 and stop a
 * compliance-obligated delete for good, since the same weddings head the next
 * run's cohort.
 *
 * A swept wedding keeps its events but leaves the cohort, because it no longer
 * holds a household or an import, so the remainder is the next run's work.
 * Capping here rather than per-query bounds the whole chain at once — the
 * aggregates, the deletes, the batched writes and the email cohort all inherit
 * it.
 */
export const MAX_WEDDINGS_PER_SWEEP = 250;

/**
 * `events.end_at` is an ISO-8601 string that begins with a zero-padded
 * `YYYY-MM-DD` date, so a lexical comparison of `MAX(end_at)` against a
 * `YYYY-MM-DD` cutoff is exact (the 10-char cutoff sorts strictly before any
 * same-day `YYYY-MM-DDThh:mm:ss…` instant) — no date parsing needed. Returns the
 * `YYYY-MM-DD` for `now - RETENTION_AFTER_FINAL_EVENT_MS`.
 */
function cutoffDateString(now: Date): string {
  const cutoff = new Date(now.getTime() - RETENTION_AFTER_FINAL_EVENT_MS);
  return cutoff.toISOString().slice(0, 10);
}

export const retentionService = {
  /**
   * Enforce the 1-year guest-data retention promise of the privacy notice.
   *
   * For every wedding whose **latest event date** is more than
   * `RETENTION_AFTER_FINAL_EVENT_MS` before `now`, delete the personal data:
   * the wedding's `rsvps` (names + RSVP status + special-category dietary text +
   * the Art. 9(2)(a) `dietaryConsentAt`/`dietaryConsentVersion` records),
   * `guests`, and `families` rows, plus its `imports` bookkeeping rows. The
   * wedding/events shell is intentionally **kept** — it carries no guest PII and
   * deleting it would orphan the published invite + slug.
   *
   * Selection: `events.end_at` / `events.start_at` are ISO-8601 strings that
   * begin with a zero-padded `YYYY-MM-DD` date, so lexical comparison against a
   * `YYYY-MM-DD` cutoff is exact. Each event's **effective end** is `end_at`,
   * falling back to `start_at` when `end_at` is the `""` no-stated-end sentinel
   * (End is optional in the events sheet) — `""` sorts before every date, so
   * the scalar `max(end_at, start_at)` picks the right one. The latest event is
   * the aggregate MAX of that, and "final event > 1 year ago" is `< cutoff`
   * (strict — a wedding whose final event is *exactly* at the cutoff is kept
   * one more day; the `YYYY-MM-DD` cutoff sorts before any same-day instant). A
   * wedding with **no events** is never selected (the group/having drops the
   * empty group) — we cannot prove its window has lapsed, so the safe default
   * is to keep it; this is also the in-progress-setup case. A wedding that
   * holds no household and no import has nothing left to delete and is not
   * selected, so weddings already swept never fill the per-run cap.
   *
   * A wedding whose gift summary cannot be written — its gifts could not be
   * counted, or its summary did not commit — is held back from this run's
   * delete: deleting it would take the gifts with no record left of them. It
   * still holds its households, so the next run tries it again, and every run
   * that holds one back logs an error. See {@link writeGiftSummaries}.
   *
   * R2 reaping: the deleted `imports` rows reference personal-data R2 objects
   * that D1's `ON DELETE cascade` can NEVER reach — the uploaded guest/event
   * sheets and each applied change's before-image (the four key columns of
   * `imports`, in the `cire-sheets` bucket, which carry guest PII). **Ordering
   * is collect-then-delete-then-reap**: we read every sheet key for the expired
   * weddings BEFORE the D1 deletes (once the `imports` rows are gone the keys
   * are unrecoverable), delete the D1 rows, then best-effort delete the R2
   * objects. A failed object
   * delete is logged + counted but never aborts the sweep (better to orphan a
   * few objects than to leave a cohort's PII in D1) — see {@link reapR2Objects}.
   * Reaping happens AFTER the rows are gone so a reap failure can't leave a live
   * row pointing at a deleted object.
   *
   * The `cire-assets` invite images are intentionally NOT touched — those rows
   * survive (the invite stays live); see {@link RetentionBuckets}.
   *
   * Run from the Worker's `scheduled` cron handler, which passes the `SHEETS`
   * binding via `buckets`. Returns the number of guest rows deleted (the
   * metric/log subject).
   */
  sweepExpiredGuestData(
    now: Date = new Date(),
    buckets: RetentionBuckets = {},
    /**
     * Optional delivery of the parting summaries — see {@link GiftSummaryNotifier}.
     * Optional because the sweep's obligation is the deletion: a deployment with
     * no ARC key or no mail transport still sweeps on time, silently.
     */
    notify?: GiftSummaryNotifier,
  ): Effect.Effect<number, RetentionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const cutoff = cutoffDateString(now);

      // Weddings whose latest event date is strictly before the cutoff. The
      // inner two-arg max() is SQLite's SCALAR max — it picks each row's
      // effective end (end_at, or start_at when end_at is the "" no-stated-end
      // sentinel, since "" sorts lexically before any ISO date). Without it a
      // wedding whose events are all open-ended would aggregate to max("") = ""
      // < cutoff and be swept immediately.
      //
      // Plain `sql`, never `.as(…)`: an aliased expression renders as its bare
      // alias inside HAVING and ORDER BY, which would move the cutoff rule onto
      // a result-column alias.
      const finalEventAt = sql<string>`max(max(${events.endAt}, ${events.startAt}))`;
      // Only weddings that still hold something this sweep deletes: every
      // guest-data table hangs off `families` (guests, rsvps, guest_events,
      // claims, contributions, sessions, links), and the sheet keys live on
      // `imports`. A swept wedding keeps its events, so without this the oldest
      // swept weddings would fill the cap on every run and no newer wedding
      // would ever be reached. In HAVING, after the cutoff test, so the probes
      // run once per expired wedding rather than once per event row; the
      // wedding id is `outerColumn` so each probe correlates to its group.
      const holdsGuestData = sql`(exists (select 1 from ${families} where ${outerColumn(families.weddingId)} = ${outerColumn(events.weddingId)}) or exists (select 1 from ${imports} where ${outerColumn(imports.weddingId)} = ${outerColumn(events.weddingId)}))`;
      const expired = yield* dbQuery(() =>
        db
          // Selected as well as filtered on: the gift summary email dates the
          // retained year from it, and this is the only read of `events` the
          // sweep makes.
          .select({ weddingId: events.weddingId, finalEventAt })
          .from(events)
          .groupBy(events.weddingId)
          .having(and(lt(finalEventAt, cutoff), holdsGuestData))
          // Bounded — see MAX_WEDDINGS_PER_SWEEP. Ordered so the cap takes the
          // longest-overdue weddings first and a backlog drains oldest-first
          // instead of leaving the same tail behind on every run.
          .orderBy(sql`${finalEventAt} asc`)
          .limit(MAX_WEDDINGS_PER_SWEEP)
          .all(),
      );
      const weddingIds = expired.map((r) => r.weddingId);
      const finalEventAtById = new Map(expired.map((r) => [r.weddingId, r.finalEventAt]));

      if (weddingIds.length === MAX_WEDDINGS_PER_SWEEP) {
        // Not an error: the next scheduled run takes the remainder. Logged so a
        // backlog that never drains is visible rather than silent.
        yield* Effect.logInfo("guest-data retention sweep hit its per-run cap", {
          cap: MAX_WEDDINGS_PER_SWEEP,
        });
      }

      if (weddingIds.length === 0) {
        yield* Effect.sync(() => metricGuestDataSwept("ok", 0));
        yield* Effect.logInfo("guest-data retention sweep complete", { weddings: 0, deleted: 0 });
        return 0;
      }

      // ── LEAVE THE COUPLE A RECORD, BEFORE TAKING THE DETAIL AWAY ──────────
      // Gifts are guest data: claims and contributions both hang off
      // `families`, so the delete below cascades them away and the couple's
      // record of what arrived goes with it. That window is deliberate (cire
      // holds no funds and has no record-keeping duty of its own), but a
      // record vanishing unannounced is not. A parting summary — counts and
      // totals, no household, no name, no note — lands on `registry_settings`,
      // which this sweep keeps. `wiki/compliance/retention.md` §Contributions.
      // The notices come back so the couple can be TOLD, below — writing the
      // record where only a portal visit would find it is not telling anyone.
      // A wedding whose summary could not be written is held back: everything
      // below runs over the rest only.
      const { notices, heldBack } = yield* writeGiftSummaries(weddingIds, finalEventAtById, now);
      const deletable =
        heldBack.size === 0 ? weddingIds : weddingIds.filter((id) => !heldBack.has(id));
      if (deletable.length === 0) {
        yield* Effect.sync(() => metricGuestDataSwept("ok", 0));
        yield* Effect.logInfo("guest-data retention sweep complete", {
          weddings: 0,
          deleted: 0,
          heldBack: heldBack.size,
        });
        return 0;
      }

      // ── COLLECT R2 SHEET KEYS FIRST ────────────────────────────────────────
      // Read every R2 key the about-to-be-deleted `imports` rows reference,
      // uploads and before-images alike, BEFORE deleting them: once the rows
      // are gone the keys are unrecoverable (D1 cascade never reaches R2). These
      // live in the `cire-sheets` bucket and carry guest PII, so they MUST be
      // reaped. (The `cire-assets` invite images are deliberately untouched —
      // see the sweep docstring + RetentionBuckets.)
      //
      // Family ids in scope — `guests` is keyed by `family_id`, not `wedding_id`,
      // so we delete guests via their families. `rsvps` is keyed by `guest_id`;
      // ON DELETE CASCADE from families → guests → rsvps would handle the
      // children, but we issue explicit deletes (parent-last) so the sweep does
      // not depend on FK cascade being enabled on every driver, and so the guest
      // delete result gives us an exact reclaimed-row count for the metric.
      //
      // Both reads are keyed only on `deletable`, so they run together.
      const [importRows, familyRows] = yield* Effect.all(
        [
          dbQuery(() =>
            db
              .select({
                eventsKey: imports.eventsR2Key,
                guestsKey: imports.guestsR2Key,
                beforeEventsKey: imports.beforeEventsR2Key,
                beforeGuestsKey: imports.beforeGuestsR2Key,
              })
              .from(imports)
              .where(inArray(imports.weddingId, jsonEachIn(deletable)))
              .all(),
          ),
          dbQuery(() =>
            db
              .select({ id: families.id })
              .from(families)
              .where(inArray(families.weddingId, jsonEachIn(deletable)))
              .all(),
          ),
        ],
        { concurrency: "unbounded" },
      );
      // The before keys are NULL on rows that never applied or whose
      // before-image was pruned; the reaper drops nulls.
      const sheetKeys = importRows.flatMap((r) => [
        r.eventsKey,
        r.guestsKey,
        r.beforeEventsKey,
        r.beforeGuestsKey,
      ]);
      const familyIds = familyRows.map((r) => r.id);

      const result = yield* Effect.tryPromise({
        try: () => {
          const stmts: BatchItem<"sqlite">[] = [];
          if (familyIds.length > 0) {
            // rsvps + guest_events → guests (children) before families (parent).
            // guest_events included for the same reason as rsvps: the sweep's
            // stated contract is to not depend on FK cascade, and it previously
            // left this one child table to the cascade it said it avoided.
            stmts.push(
              db.delete(rsvps).where(
                inArray(
                  rsvps.guestId,
                  db
                    .select({ id: guests.id })
                    .from(guests)
                    .where(inArray(guests.familyId, jsonEachIn(familyIds))),
                ),
              ),
            );
            stmts.push(
              db.delete(guestEvents).where(
                inArray(
                  guestEvents.guestId,
                  db
                    .select({ id: guests.id })
                    .from(guests)
                    .where(inArray(guests.familyId, jsonEachIn(familyIds))),
                ),
              ),
            );
            stmts.push(db.delete(guests).where(inArray(guests.familyId, jsonEachIn(familyIds))));
            stmts.push(db.delete(families).where(inArray(families.id, jsonEachIn(familyIds))));
          }
          // imports bookkeeping (the uploaded-sheet PII references). The R2
          // objects behind these (+ the invite-image columns) are reaped AFTER
          // this batch commits — their keys were collected above, pre-delete.
          // Last, so the batch is never empty. The statements are in FK order,
          // children first, which the bun:sqlite fallback keeps.
          return commitBatchResults(db, [
            ...stmts,
            db.delete(imports).where(inArray(imports.weddingId, jsonEachIn(deletable))),
          ]);
        },
        catch: (e) => new RetentionWriteError({ op: "sweep", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("guest-data retention sweep failed", { reason: err.reason }),
        ),
      );

      // The guests delete is the (familyIds>0 ? third : absent) statement
      // (after the rsvps + guest_events child deletes); report the guest count
      // as the subject.
      const guestsDeleted =
        familyIds.length > 0 && Array.isArray(result) ? rowsChanged(result[2]) : 0;

      yield* Effect.sync(() => metricGuestDataSwept("ok", guestsDeleted));
      yield* Effect.logInfo("guest-data retention sweep complete", {
        weddings: deletable.length,
        deleted: guestsDeleted,
        heldBack: heldBack.size,
      });

      // ── REAP R2 OBJECTS (best-effort, post-delete) ─────────────────────────
      // The `imports` rows are gone; now delete the sheet objects they pointed
      // at. Best-effort (logs + counts failures, never throws) so an R2
      // hiccup can't fail the sweep or leave guest PII stuck in D1. Keys were
      // collected before the deletes above.
      yield* reapR2Objects(buckets.sheets, "sheets", sheetKeys);

      // ── TELL THE COUPLE, LAST ─────────────────────────────────────────────
      // After the deletes have committed, and deliberately so: the email says
      // the detail is gone, so it must not go out while it is still there.
      //
      // One attempt, no retry, no queue. The notifier cannot fail (error
      // channel `never`) but it can HANG — an unreachable mail host or a stuck
      // osn-api — and a cron sweep that waits on a mailbox is a sweep that
      // stops running. The timeout bounds that, the catch swallows what the
      // timeout raises, and neither can reach the sweep's own error channel.
      if (notify && notices.length > 0) {
        yield* notify(notices).pipe(
          Effect.timeout("30 seconds"),
          Effect.catchCause((cause) =>
            Effect.logWarning("gift summary notices not delivered").pipe(
              // Fixed strings, never `String(cause)`. `notify` is a
              // caller-supplied function type: whatever a future notifier puts
              // in an error message would land in this log line, and the thing
              // it is holding is an organiser's email address. The two shapes
              // that can reach here — the timeout above, or a defect from a
              // notifier whose error channel says it has none — are worth
              // telling apart, and neither name carries data.
              Effect.annotateLogs({
                reason: Cause.hasFails(cause) ? "timeout" : "defect",
                weddings: notices.length,
              }),
            ),
          ),
        );
      }

      return guestsDeleted;
    }).pipe(
      // Cause-level, not `tapError`: a failed `dbQuery` read is a defect, and
      // must count and log like the typed delete failure (which is logged where
      // it is raised, above).
      Effect.tapCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.void
          : Effect.sync(() => metricGuestDataSwept("error")).pipe(
              Effect.andThen(
                Cause.hasDies(cause)
                  ? Effect.logError("guest-data retention sweep failed").pipe(
                      Effect.annotateLogs({ reason: String(Cause.squash(cause)) }),
                    )
                  : Effect.void,
              ),
            ),
      ),
      Effect.withSpan("cire.retention.sweepExpiredGuestData"),
    );
  },
};

/**
 * The shape written into `registry_settings.gift_summary_json`.
 *
 * Aggregates only, and that is the whole design: the sweep exists to delete the
 * per-guest detail, so a summary carrying a household, a name or a note would be
 * the deletion undone in the row next door. Money is summed PER CURRENCY rather
 * than converted — a total that re-values itself is not a record of anything,
 * and the FX columns are null for the common same-currency case anyway.
 */
export interface GiftSummary {
  /** When the detail was deleted, ISO date. */
  sweptOn: string;
  /**
   * The span the counted gifts arrived over, ISO days, both ends inclusive.
   *
   * A count with no dates on it is a number, not a record — "18 gifts" says
   * nothing about the wedding it belongs to once the rows are gone. Taken from
   * the same rows as the counts, so the two can never describe different sets:
   * a released claim and an unsettled charge fall outside the range for exactly
   * the reason they fall outside the totals. Equal to each other on a wedding
   * whose gifts all arrived on one day, which is a fact about that wedding and
   * not a fault.
   */
  firstGiftOn: string;
  lastGiftOn: string;
  /** Gifts reserved from the list, and how many of them were marked purchased. */
  claims: { reserved: number; purchased: number };
  /** Money gifts that actually settled, per currency, in minor units. */
  contributions: { count: number; totals: { currency: string; amountMinor: number }[] };
}

/**
 * A summary mid-fold, before it is written.
 *
 * Same counts as {@link GiftSummary}, but the arrival span is still in epoch
 * SECONDS — the two source queries each report their own min and max, and "the
 * earlier of two dates" is only cheap while they are still numbers. Rendered to
 * ISO days once, at the write.
 */
interface SummaryDraft {
  claims: { reserved: number; purchased: number };
  contributions: { count: number; totals: { currency: string; amountMinor: number }[] };
  firstAt: number | null;
  lastAt: number | null;
}

/**
 * An epoch-SECONDS timestamp as an ISO calendar day.
 *
 * `integer({ mode: "timestamp" })` stores seconds in SQLite, and the raw
 * `min()`/`max()` aggregates below hand back the stored integer rather than a
 * Date — drizzle's timestamp mapping only runs on a column selected whole. So
 * the ×1000 is ours to do, and it fails silently if we forget: the JSON still
 * writes, it just dates every gift to 1970.
 */
const isoDay = (seconds: number): string => new Date(seconds * 1000).toISOString().slice(0, 10);

/**
 * What the sweep hands its notifier: one wedding's parting summary, plus the
 * facts the email needs that the summary itself does not carry — who owns the
 * wedding (OSN profile ids, because cire holds no address), what the couple
 * named it, which currency they think in, and when the retained year started.
 */
export interface GiftSummaryNotice {
  readonly weddingId: string;
  readonly weddingName: string;
  /** Every owner of the wedding, in seat order. Never empty: a wedding with no
   *  owner to mail drops out before a notice is built. */
  readonly ownerOsnProfileIds: readonly string[];
  readonly currency: string;
  /** `YYYY-MM-DD` of the last event — the far end of the retained year. */
  readonly finalEventOn: string;
  readonly summary: GiftSummary;
}

/**
 * Delivery of the parting summaries, supplied by the caller.
 *
 * The error channel is `never` and the context is `never` by contract: the
 * sweep will not carry a mail transport in its requirements, and delivery must
 * not be able to fail the deletion. Whoever builds one handles its own
 * failures (see `cire/api/src/lib/gift-summary-email.ts`).
 */
export type GiftSummaryNotifier = (
  notices: readonly GiftSummaryNotice[],
) => Effect.Effect<void, never, never>;

/** What {@link writeGiftSummaries} hands back to the sweep. */
interface GiftSummaryOutcome {
  /** One per wedding whose summary is stored and whose owners were read. */
  readonly notices: readonly GiftSummaryNotice[];
  /**
   * Weddings whose summary could not be written. The sweep keeps their guest
   * data for the next run, which counts their gifts again.
   */
  readonly heldBack: ReadonlySet<string>;
}

/**
 * Handle a failure, but pass an interruption on: a sweep that is being
 * stopped must stop, not log a database failure and carry on.
 */
const unlessInterrupted =
  <A>(handle: (cause: Cause.Cause<unknown>) => Effect.Effect<A>) =>
  (cause: Cause.Cause<unknown>): Effect.Effect<A> =>
    Cause.hasInterruptsOnly(cause) ? Effect.interrupt : handle(cause);

/**
 * A wedding's summary from an earlier sweep with this sweep's new gifts added
 * in. A wedding comes back into the cohort when it gains a household after
 * being swept — a re-import, or the host's own preview household — and the
 * record has to cover every gift ever deleted, not only the latest rows.
 */
function mergeGiftSummaries(stored: GiftSummary, fresh: GiftSummary): GiftSummary {
  const totals = new Map<string, number>();
  for (const total of [...stored.contributions.totals, ...fresh.contributions.totals]) {
    totals.set(total.currency, (totals.get(total.currency) ?? 0) + total.amountMinor);
  }
  return {
    sweptOn: fresh.sweptOn,
    firstGiftOn: stored.firstGiftOn < fresh.firstGiftOn ? stored.firstGiftOn : fresh.firstGiftOn,
    lastGiftOn: stored.lastGiftOn > fresh.lastGiftOn ? stored.lastGiftOn : fresh.lastGiftOn,
    claims: {
      reserved: stored.claims.reserved + fresh.claims.reserved,
      purchased: stored.claims.purchased + fresh.claims.purchased,
    },
    contributions: {
      count: stored.contributions.count + fresh.contributions.count,
      // Code order, as the read below sorts them.
      totals: [...totals.keys()]
        .toSorted()
        .map((currency) => ({ currency, amountMinor: totals.get(currency) ?? 0 })),
    },
  };
}

/**
 * Count each expiring wedding's gifts into the summary it will keep: the
 * claims and contributions aggregates, folded per wedding, merged into any
 * summary an earlier sweep stored. A wedding with no gifts has no entry. Fails
 * as a whole — the reads span the cohort, so a failed one cannot say which
 * weddings had gifts.
 */
function countGiftSummaries(
  weddingIds: readonly string[],
  now: Date,
): Effect.Effect<Map<string, GiftSummary>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const ids = [...weddingIds];

    // Grouped in SQLite, not folded in JS. The row counts here scale with how
    // many gifts a cohort of weddings received, not with how many weddings are
    // expiring — a popular list is thousands of claims — and every one of those
    // rows would otherwise cross the D1 wire to be added up. Grouped, the answer
    // is a handful of rows per wedding whatever the traffic was.
    //
    // All three reads are keyed only on `ids`, so they run together. The third
    // finds the summaries earlier sweeps stored, which only a wedding that came
    // back into the cohort has.
    const [claimRows, giftRows, storedRows] = yield* Effect.all(
      [
        dbQuery(() =>
          db
            .select({
              weddingId: registryClaims.weddingId,
              status: registryClaims.status,
              // Clamped per row, inside the sum: a single negative quantity must not
              // subtract from the gifts the couple really were given.
              quantity: sql<number>`sum(max(${registryClaims.quantity}, 0))`,
              // Epoch SECONDS, not Dates: a raw aggregate bypasses the timestamp
              // mapping drizzle applies to a column selected whole. Grouped with the
              // counts and filtered by the same WHERE, so the range can only ever
              // describe the rows the counts describe.
              firstAt: sql<number>`min(${registryClaims.createdAt})`,
              lastAt: sql<number>`max(${registryClaims.createdAt})`,
            })
            .from(registryClaims)
            // A released claim is a tombstone, not a gift — it is what the couple did
            // NOT receive, and counting it would overstate the record.
            .where(
              and(
                inArray(registryClaims.weddingId, jsonEachIn(ids)),
                ne(registryClaims.status, "released"),
              ),
            )
            .groupBy(registryClaims.weddingId, registryClaims.status)
            .all(),
        ),
        dbQuery(() =>
          db
            .select({
              weddingId: registryContributions.weddingId,
              currency: registryContributions.currency,
              count: sql<number>`count(*)`,
              amountMinor: sql<number>`sum(max(${registryContributions.amountMinor}, 0))`,
              // Epoch SECONDS, same as the claims query above. Under the same
              // `status = 'succeeded'` filter, so a charge that never settled moves
              // neither the totals nor the dates.
              firstAt: sql<number>`min(${registryContributions.createdAt})`,
              lastAt: sql<number>`max(${registryContributions.createdAt})`,
            })
            .from(registryContributions)
            .where(
              and(
                inArray(registryContributions.weddingId, jsonEachIn(ids)),
                // Only money that actually moved. A pending or failed row is not a gift.
                eq(registryContributions.status, "succeeded"),
              ),
            )
            .groupBy(registryContributions.weddingId, registryContributions.currency)
            // Sorted here rather than in JS: the summary is a record somebody reads,
            // and a stable currency order is part of it being one.
            .orderBy(registryContributions.currency)
            .all(),
        ),
        dbQuery(() =>
          db
            .select({
              weddingId: registrySettings.weddingId,
              json: registrySettings.giftSummaryJson,
              at: registrySettings.giftSummaryAt,
            })
            .from(registrySettings)
            .where(
              and(
                inArray(registrySettings.weddingId, jsonEachIn(ids)),
                isNotNull(registrySettings.giftSummaryJson),
              ),
            )
            .all(),
        ),
      ],
      { concurrency: "unbounded" },
    );

    const summaries = new Map<string, SummaryDraft>();
    const sweptOn = now.toISOString().slice(0, 10);
    const blank = (): SummaryDraft => ({
      claims: { reserved: 0, purchased: 0 },
      contributions: { count: 0, totals: [] },
      firstAt: null,
      lastAt: null,
    });
    /**
     * Widen a draft's span to cover one query's min and max.
     *
     * Null is "this query had no rows for this wedding", not a date — a wedding
     * with claims and no cash gifts must not have its range pulled to the epoch
     * by the query that found nothing.
     */
    const widen = (draft: SummaryDraft, first: number | null, last: number | null): void => {
      if (first !== null) {
        draft.firstAt = draft.firstAt === null ? first : Math.min(draft.firstAt, first);
      }
      if (last !== null) {
        draft.lastAt = draft.lastAt === null ? last : Math.max(draft.lastAt, last);
      }
    };

    for (const row of claimRows as Array<{
      weddingId: string;
      status: string;
      quantity: number;
      firstAt: number | null;
      lastAt: number | null;
    }>) {
      const summary = summaries.get(row.weddingId) ?? blank();
      const quantity = row.quantity ?? 0;
      if (row.status === "purchased") summary.claims.purchased += quantity;
      else summary.claims.reserved += quantity;
      widen(summary, row.firstAt, row.lastAt);
      summaries.set(row.weddingId, summary);
    }

    for (const row of giftRows as Array<{
      weddingId: string;
      currency: string;
      count: number;
      amountMinor: number;
      firstAt: number | null;
      lastAt: number | null;
    }>) {
      const summary = summaries.get(row.weddingId) ?? blank();
      summary.contributions.count += row.count;
      summary.contributions.totals.push({
        currency: row.currency,
        amountMinor: row.amountMinor ?? 0,
      });
      widen(summary, row.firstAt, row.lastAt);
      summaries.set(row.weddingId, summary);
    }

    const stored = new Map(
      storedRows.flatMap((row) => {
        const summary = decodeGiftSummary(row.json, row.at);
        return summary ? [[row.weddingId, summary] as const] : [];
      }),
    );

    // The span falls back to the sweep date rather than going absent. Every
    // row that produced a count also carried a `created_at`, so a null here
    // would mean the counts came from nowhere; saying "on the day we swept" is
    // wrong by at most a year, where a missing field would leave the portal
    // deciding what to print out of nothing.
    return new Map(
      [...summaries].map(([weddingId, draft]) => {
        const fresh: GiftSummary = {
          sweptOn,
          firstGiftOn: draft.firstAt === null ? sweptOn : isoDay(draft.firstAt),
          lastGiftOn: draft.lastAt === null ? sweptOn : isoDay(draft.lastAt),
          claims: draft.claims,
          contributions: draft.contributions,
        };
        const earlier = stored.get(weddingId);
        return [weddingId, earlier ? mergeGiftSummaries(earlier, fresh) : fresh];
      }),
    );
  });
}

/**
 * Store each summary on its wedding's `registry_settings` row, one D1 batch of
 * at most `MAX_STATEMENTS_PER_BATCH` single-row UPDATEs at a time. Each batch
 * commits or fails as a unit, and on its own: a failed one holds back its
 * weddings and the rest carry on. A wedding counts as stored only when its
 * UPDATE changed a row.
 */
function commitGiftSummaries(
  summaries: ReadonlyMap<string, GiftSummary>,
  now: Date,
): Effect.Effect<
  { stored: ReadonlyMap<string, GiftSummary>; heldBack: ReadonlySet<string> },
  never,
  DbService
> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const entries = [...summaries];
    const chunks: (readonly [string, GiftSummary])[][] = [];
    for (let i = 0; i < entries.length; i += MAX_STATEMENTS_PER_BATCH) {
      chunks.push(entries.slice(i, i + MAX_STATEMENTS_PER_BATCH));
    }

    const outcomes = yield* Effect.forEach(chunks, (chunk) =>
      dbQuery(() =>
        commitBatchResults(
          db,
          chunk.map(([weddingId, summary]) =>
            db
              .update(registrySettings)
              .set({
                giftSummaryJson: JSON.stringify(summary),
                giftSummaryAt: now,
                updatedAt: now,
              })
              .where(eq(registrySettings.weddingId, weddingId)),
          ),
        ),
      ).pipe(
        Effect.map((results) => ({
          stored: chunk.filter((_, i) => rowsChanged(results[i]) > 0),
          rowless: chunk.filter((_, i) => rowsChanged(results[i]) === 0).length,
          failed: [] as string[],
        })),
        Effect.catchCause(
          unlessInterrupted((cause) =>
            Effect.logError("gift summaries not written — held back from the delete").pipe(
              Effect.annotateLogs({ weddings: chunk.length, reason: String(Cause.squash(cause)) }),
              Effect.andThen(
                Effect.sync(() => metricGiftSummaryWritten("write_failed", chunk.length)),
              ),
              Effect.as({
                stored: [] as (readonly [string, GiftSummary])[],
                rowless: 0,
                failed: chunk.map(([weddingId]) => weddingId),
              }),
            ),
          ),
        ),
      ),
    );

    const stored = new Map(outcomes.flatMap((o) => o.stored));
    const heldBack = new Set(outcomes.flatMap((o) => o.failed));
    const rowless = outcomes.reduce((n, o) => n + o.rowless, 0);
    if (stored.size > 0) yield* Effect.sync(() => metricGiftSummaryWritten("ok", stored.size));
    if (rowless > 0) {
      // A gift needs a published registry, so its settings row should exist.
      // One that does not has nowhere to keep the summary; it is not mailed,
      // and holding the wedding back would only wait for a row nothing creates.
      yield* Effect.logWarning("gift summaries had no registry row to land on — not mailed").pipe(
        Effect.annotateLogs({ weddings: rowless }),
      );
    }
    return { stored, heldBack };
  });
}

/**
 * Build the notice for each stored summary: the wedding's owners (OSN profile
 * ids, oldest seat first), its name and its currency. A soft-deleted wedding,
 * or one whose row has gone, has no owner to mail and drops out.
 */
function giftSummaryNotices(
  stored: ReadonlyMap<string, GiftSummary>,
  finalEventAtById: ReadonlyMap<string, string>,
): Effect.Effect<readonly GiftSummaryNotice[], never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    // One query for the lot: each wedding row joined to its owner seats, one
    // row per owner, oldest seat first.
    const ownerRows = yield* dbQuery(() =>
      db
        .select({
          id: weddings.id,
          displayName: weddings.displayName,
          currency: weddings.currency,
          ownerOsnProfileId: weddingHosts.osnProfileId,
        })
        .from(weddings)
        .innerJoin(
          weddingHosts,
          and(eq(weddingHosts.weddingId, weddings.id), eq(weddingHosts.role, "owner")),
        )
        // A soft-deleted wedding's owners are not mailed; its summary row is
        // still written, so a restore finds it.
        .where(and(inArray(weddings.id, jsonEachIn([...stored.keys()])), weddingIsLive))
        .orderBy(asc(weddingHosts.createdAt))
        .all(),
    );
    const byWedding = new Map<
      string,
      { displayName: string; currency: string; owners: string[] }
    >();
    for (const row of ownerRows) {
      const entry = byWedding.get(row.id) ?? {
        displayName: row.displayName,
        currency: row.currency,
        owners: [],
      };
      entry.owners.push(row.ownerOsnProfileId);
      byWedding.set(row.id, entry);
    }

    return [...byWedding].flatMap(([weddingId, w]) => {
      const summary = stored.get(weddingId);
      if (!summary) return [];
      return [
        {
          weddingId,
          weddingName: w.displayName,
          ownerOsnProfileIds: w.owners,
          currency: w.currency,
          finalEventOn: (finalEventAtById.get(weddingId) ?? "").slice(0, 10),
          summary,
        },
      ];
    });
  }).pipe(
    Effect.catchCause(
      unlessInterrupted((cause) =>
        // The summaries are stored, so the line must not say they were lost:
        // what failed is finding who to tell.
        Effect.logError("gift summaries written, owners not read — none mailed").pipe(
          Effect.annotateLogs({ summaries: stored.size, reason: String(Cause.squash(cause)) }),
          Effect.andThen(
            Effect.sync(() => metricGiftSummaryUnmailed("owners_unread", stored.size)),
          ),
          Effect.as([] as readonly GiftSummaryNotice[]),
        ),
      ),
    ),
  );
}

/**
 * Write each expiring wedding's parting gift summary, and return what was
 * written so the caller can deliver it, and which weddings to hold back.
 *
 * Runs BEFORE the delete, obviously — afterwards there is nothing to count. A
 * wedding with no gifts at all gets no row written: an empty summary is noise
 * on a page, and its absence says the same thing more quietly.
 *
 * Never fails the sweep, and never lets it delete gifts it could not record.
 * A wedding whose gifts could not be counted, or whose summary did not
 * commit, comes back in `heldBack`, and the sweep keeps its guest data for the
 * next run. How many that is follows the queries: a failed count holds back
 * the whole cohort (one read covers it), a failed commit holds back the
 * weddings in that batch. Every failure is logged at error level on every run
 * it happens. A summary that is not stored is never mailed.
 *
 * Every catch here is cause-level: `dbQuery` surfaces a failed query as a
 * defect, which `Effect.catch` would not see.
 */
function writeGiftSummaries(
  weddingIds: readonly string[],
  /** Each wedding's final-event effective end, from the sweep's cohort query. */
  finalEventAtById: ReadonlyMap<string, string>,
  now: Date,
): Effect.Effect<GiftSummaryOutcome, never, DbService> {
  return Effect.gen(function* () {
    const counted = yield* countGiftSummaries(weddingIds, now).pipe(
      Effect.catchCause(
        unlessInterrupted((cause) =>
          Effect.logError("gift summaries not written — held back from the delete").pipe(
            Effect.annotateLogs({
              weddings: weddingIds.length,
              reason: String(Cause.squash(cause)),
            }),
            Effect.andThen(
              Effect.sync(() => metricGiftSummaryWritten("read_failed", weddingIds.length)),
            ),
            Effect.as(null),
          ),
        ),
      ),
    );
    if (counted === null) return { notices: [], heldBack: new Set(weddingIds) };
    if (counted.size === 0) return { notices: [], heldBack: new Set<string>() };

    const { stored, heldBack } = yield* commitGiftSummaries(counted, now);
    // Everything below is for the EMAIL, not the stored summary: an address to
    // reach the couple at, a name to call the wedding, and a currency to print
    // the total in. Read after the summaries are written so a cohort with no
    // gifts pays for none of it.
    const notices = stored.size > 0 ? yield* giftSummaryNotices(stored, finalEventAtById) : [];
    return { notices, heldBack };
  }).pipe(Effect.withSpan("cire.retention.writeGiftSummaries"));
}
