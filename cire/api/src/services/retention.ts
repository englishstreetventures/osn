import { events, families, guests, imports, rsvps } from "@cire/db";
import { inArray, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricGuestDataSwept } from "../metrics";
import type { DeletableBucket } from "./r2-cleanup";
import { reapR2Objects } from "./r2-cleanup";

/**
 * R2 bindings the retention sweep reaps into. Optional — a deployment missing
 * the binding (local dev / misconfig) still purges the D1 rows; the orphaned
 * objects are logged + counted as errors by {@link reapR2Objects}.
 *
 *  - `sheets` — the `cire-sheets` bucket (binding `SHEETS`): the uploaded
 *    guest/event spreadsheets referenced by `imports.events_r2_key` /
 *    `guests_r2_key`. The sweep deletes the `imports` rows, so these objects
 *    ARE orphaned by it and must be reaped here (IB-S-L2 / C-H1).
 *
 * NOTE — the `cire-assets` invite images (`wedding_invite_customisations`
 * hero/story keys + `events.event_image_key`) are deliberately NOT reaped here:
 * the retention sweep KEEPS the wedding + events shell + the published invite,
 * so those rows survive and keep pointing at their objects (the invite stays
 * live). Deleting them would 404 the live invite and dangle the DB keys. The
 * `cire-assets` orphan path (failed best-effort cleanup on re-upload/remove, and
 * a future wedding-DELETE fan-out) is a separate IB-S-L2 follow-up — there is no
 * wedding-delete flow today to hook. {@link reapR2Objects} stays bucket-agnostic
 * so that flow, when it lands, can reuse it for BOTH buckets.
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
 * (`cire/web/src/pages/privacy.astro`) promises guest data is deleted **1 year
 * after the final wedding event**. This constant encodes that window; change it
 * here (and the notice copy) to move the line. 365 days in milliseconds.
 */
export const RETENTION_AFTER_FINAL_EVENT_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * Rows changed by a Drizzle `.run()` write, normalised across drivers.
 * bun:sqlite returns `{ changes }`; Cloudflare D1 returns `{ meta: { changes } }`.
 */
function rowsChanged(result: unknown): number {
  if (typeof result !== "object" || result === null) return 0;
  const r = result as { changes?: number; meta?: { changes?: number } };
  return r.meta?.changes ?? r.changes ?? 0;
}

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
   * Enforce the 1-year guest-data retention promise (C-H2 / privacy notice).
   *
   * For every wedding whose **latest event date** is more than
   * `RETENTION_AFTER_FINAL_EVENT_MS` before `now`, delete the personal data:
   * the wedding's `rsvps` (names + RSVP status + special-category dietary text +
   * the Art. 9(2)(a) `dietaryConsentAt`/`dietaryConsentVersion` records),
   * `guests`, and `families` rows, plus its `imports` bookkeeping rows. The
   * wedding/events shell is intentionally **kept** — it carries no guest PII and
   * deleting it would orphan the published invite + slug.
   *
   * Selection: `events.end_at` is an ISO-8601 string that begins with a
   * zero-padded `YYYY-MM-DD` date, so the latest event is `MAX(end_at)` and
   * "final event > 1 year ago" is `MAX(end_at) < cutoff` (strict — a wedding
   * whose final event is *exactly* at the cutoff is kept one more day; the
   * `YYYY-MM-DD` cutoff sorts before any same-day instant). A wedding with **no
   * events** is never selected (the group/having drops the empty group) — we
   * cannot prove its window has lapsed, so the safe default is to keep it; this
   * is also the in-progress-setup case.
   *
   * R2 reaping (IB-S-L2 / C-H1): the deleted `imports` rows reference
   * personal-data R2 objects that D1's `ON DELETE cascade` can NEVER reach — the
   * uploaded guest/event sheets (`imports.events_r2_key`/`guests_r2_key` in the
   * `cire-sheets` bucket, which carry guest PII). **Ordering is collect-then-
   * delete-then-reap**: we read every sheet key for the expired weddings BEFORE
   * the D1 deletes (once the `imports` rows are gone the keys are unrecoverable),
   * delete the D1 rows, then best-effort delete the R2 objects. A failed object
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
  ): Effect.Effect<number, RetentionWriteError, DbService> {
    return Effect.gen(function* () {
      const db = yield* DbService;
      const cutoff = cutoffDateString(now);

      // Weddings whose latest event date is strictly before the cutoff.
      const expired = yield* dbQuery(() =>
        db
          .select({ weddingId: events.weddingId })
          .from(events)
          .groupBy(events.weddingId)
          .having(lt(sql`max(${events.endAt})`, cutoff))
          .all(),
      );
      const weddingIds = expired.map((r) => r.weddingId);

      if (weddingIds.length === 0) {
        yield* Effect.sync(() => metricGuestDataSwept("ok", 0));
        yield* Effect.logInfo("guest-data retention sweep complete", { weddings: 0, deleted: 0 });
        return 0;
      }

      // ── COLLECT R2 SHEET KEYS FIRST ────────────────────────────────────────
      // Read every uploaded-sheet R2 key the about-to-be-deleted `imports` rows
      // reference BEFORE deleting them — once the rows are gone the keys are
      // unrecoverable (D1 cascade never reaches R2). These live in the
      // `cire-sheets` bucket and carry guest PII, so they MUST be reaped. (The
      // `cire-assets` invite images are deliberately untouched — see the sweep
      // docstring + RetentionBuckets.)
      const importRows = yield* dbQuery(() =>
        db
          .select({ eventsKey: imports.eventsR2Key, guestsKey: imports.guestsR2Key })
          .from(imports)
          .where(inArray(imports.weddingId, weddingIds))
          .all(),
      );
      const sheetKeys = importRows.flatMap((r) => [r.eventsKey, r.guestsKey]);

      // Family ids in scope — `guests` is keyed by `family_id`, not `wedding_id`,
      // so we delete guests via their families. `rsvps` is keyed by `guest_id`;
      // ON DELETE CASCADE from families → guests → rsvps would handle the
      // children, but we issue explicit deletes (parent-last) so the sweep does
      // not depend on FK cascade being enabled on every driver, and so the guest
      // delete result gives us an exact reclaimed-row count for the metric.
      const familyRows = yield* dbQuery(() =>
        db
          .select({ id: families.id })
          .from(families)
          .where(inArray(families.weddingId, weddingIds))
          .all(),
      );
      const familyIds = familyRows.map((r) => r.id);

      const result = yield* Effect.tryPromise({
        try: () => {
          const stmts: BatchItem<"sqlite">[] = [];
          if (familyIds.length > 0) {
            // rsvps → guests (children) before families (parent).
            stmts.push(
              db
                .delete(rsvps)
                .where(
                  inArray(
                    rsvps.guestId,
                    db
                      .select({ id: guests.id })
                      .from(guests)
                      .where(inArray(guests.familyId, familyIds)),
                  ),
                ),
            );
            stmts.push(db.delete(guests).where(inArray(guests.familyId, familyIds)));
            stmts.push(db.delete(families).where(inArray(families.id, familyIds)));
          }
          // imports bookkeeping (the uploaded-sheet PII references). The R2
          // objects behind these (+ the invite-image columns) are reaped AFTER
          // this batch commits — their keys were collected above, pre-delete.
          stmts.push(db.delete(imports).where(inArray(imports.weddingId, weddingIds)));

          const batchable = db as {
            batch?: (s: [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]) => Promise<unknown[]>;
          };
          if (typeof batchable.batch === "function" && stmts.length > 0) {
            return batchable.batch(stmts as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
          }
          // bun:sqlite (tests/local): no .batch(); run sequentially, children first.
          return (async () => {
            const out: unknown[] = [];
            // FK-ordered deletes: children must commit before parents, so
            // sequential awaiting is the contract, not an oversight.
            // oxlint-disable-next-line no-await-in-loop
            for (const stmt of stmts) out.push(await stmt);
            return out;
          })();
        },
        catch: (e) => new RetentionWriteError({ op: "sweep", reason: String(e) }),
      }).pipe(
        Effect.tapError((err) =>
          Effect.logError("guest-data retention sweep failed", { reason: err.reason }),
        ),
      );

      // The guests delete is the (familyIds>0 ? second : absent) statement; sum
      // every result's changed-rows but report the guest count as the subject.
      const guestsDeleted =
        familyIds.length > 0 && Array.isArray(result) ? rowsChanged(result[1]) : 0;

      yield* Effect.sync(() => metricGuestDataSwept("ok", guestsDeleted));
      yield* Effect.logInfo("guest-data retention sweep complete", {
        weddings: weddingIds.length,
        deleted: guestsDeleted,
      });

      // ── REAP R2 OBJECTS (best-effort, post-delete) ─────────────────────────
      // The `imports` rows are gone; now delete the uploaded-sheet objects they
      // pointed at. Best-effort (logs + counts failures, never throws) so an R2
      // hiccup can't fail the sweep or leave guest PII stuck in D1. Keys were
      // collected before the deletes above.
      yield* reapR2Objects(buckets.sheets, "sheets", sheetKeys);

      return guestsDeleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricGuestDataSwept("error"))),
      Effect.withSpan("cire.retention.sweepExpiredGuestData"),
    );
  },
};
