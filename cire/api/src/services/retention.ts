import { events, families, guests, imports, rsvps } from "@cire/db";
import { inArray, lt, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import { Data, Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { metricGuestDataSwept } from "../metrics";

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
 * `events.date` is a zero-padded `YYYY-MM-DD` string, so lexical order equals
 * chronological order — a string comparison against the cutoff date is exact and
 * needs no parsing. Returns the `YYYY-MM-DD` for `now - RETENTION_AFTER_FINAL_EVENT_MS`.
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
   * Selection: `events.date` is a zero-padded `YYYY-MM-DD` string, so the latest
   * event is `MAX(date)` and "final event > 1 year ago" is `MAX(date) < cutoff`
   * (strict — a wedding whose final event is *exactly* at the cutoff is kept one
   * more day). A wedding with **no events** is never selected (the inner join
   * drops it) — we cannot prove its window has lapsed, so the safe default is to
   * keep it; this is also the in-progress-setup case.
   *
   * R2 note: the `imports` rows reference R2 objects (`eventsR2Key`/`guestsR2Key`,
   * the uploaded sheets which contain guest PII). This sweep deletes the DB rows
   * but does NOT delete the R2 objects — the sweep is a pure-Drizzle Effect with
   * no R2 binding in scope. See the TODO below; the objects must be reaped by a
   * separate R2-aware pass (or an R2 lifecycle rule keyed on the `imports/` prefix).
   *
   * Run from the Worker's `scheduled` cron handler. Returns the number of guest
   * rows deleted (the metric/log subject).
   */
  // TODO(retention-r2): delete the R2 objects behind expired weddings' `imports`
  // rows (`eventsR2Key`/`guestsR2Key` in the SHEETS bucket). Needs an R2 binding
  // threaded into this service; until then the uploaded sheets outlive the DB
  // rows. Tracked in cire/wiki/todo/api.md.
  sweepExpiredGuestData(
    now: Date = new Date(),
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
          .having(lt(sql`max(${events.date})`, cutoff))
          .all(),
      );
      const weddingIds = expired.map((r) => r.weddingId);

      if (weddingIds.length === 0) {
        yield* Effect.sync(() => metricGuestDataSwept("ok", 0));
        yield* Effect.logInfo("guest-data retention sweep complete", { weddings: 0, deleted: 0 });
        return 0;
      }

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
          // imports bookkeeping (the uploaded-sheet PII references). R2 objects
          // are NOT reaped here — see the service-level TODO.
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
      return guestsDeleted;
    }).pipe(
      Effect.tapError(() => Effect.sync(() => metricGuestDataSwept("error"))),
      Effect.withSpan("cire.retention.sweepExpiredGuestData"),
    );
  },
};
