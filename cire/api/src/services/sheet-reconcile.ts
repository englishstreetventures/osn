/**
 * `cire-sheets` orphan reconciliation.
 *
 * Every change an organiser makes — a spreadsheet upload or an editor save —
 * stores two objects in the `cire-sheets` R2 bucket (binding `SHEETS`) and an
 * `imports` row naming them; applying it stores two more, its before-image
 * (`r2-imports.ts` for the key shapes, `checkpoint.ts` for the before-image).
 * They hold guest PII. The retention sweep, the stale-preview sweep, the purge
 * of deleted weddings and the before-image prune each delete these objects
 * best-effort after their D1 write, so a failed delete leaves an object no row
 * names and nothing retries. So does a request that stores the objects and then
 * fails before its row write.
 *
 * "Referenced" is decided per KEY, from the four key columns of every `imports`
 * row, never per import id: the prune keeps a change's row and NULLs its before
 * keys, so a row can exist while two of its objects are orphans.
 *
 * The walk and its guards are {@link reconcileOrphanObjects} in
 * `r2-reconcile.ts`. An empty `imports` table while sheets exist is one of those
 * guards: the run deletes nothing and logs a warning until any change row exists.
 */
import { imports } from "@cire/db";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { reconcileOrphanObjects } from "./r2-reconcile";
import type { ListBudget, R2ReconcileError, ReconcilableBucket } from "./r2-reconcile";

/** Every sheet object lives under this prefix; nothing else is touched. */
export const SHEETS_PREFIX = "imports/";

/**
 * What one run may list: ten full pages, plus two calls for pages R2 returns
 * short. The daily cron runs eleven jobs in one invocation on Workers Free
 * (`wiki/shared/free-tier-limits.md`), so the walk stays bounded however large
 * the bucket grows. A bucket past 10,000 objects is walked only up to the
 * budget, from the same end each run, and the run logs a warning saying so.
 */
export const SHEET_LIST_BUDGET: ListBudget = { maxObjects: 10_000, maxListCalls: 12 };

/**
 * Every non-null key in the four key columns of every `imports` row, in any
 * status. One statement with no bound parameters. It reads the whole table, so
 * its size grows with the number of change rows the retention and stale-preview
 * sweeps have not yet removed.
 */
function loadReferencedSheetKeys(): Effect.Effect<Set<string>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db
        .select({
          events: imports.eventsR2Key,
          guests: imports.guestsR2Key,
          beforeEvents: imports.beforeEventsR2Key,
          beforeGuests: imports.beforeGuestsR2Key,
        })
        .from(imports)
        .all(),
    );
    const referenced = new Set<string>();
    for (const row of rows) {
      for (const key of Object.values(row)) {
        if (key) referenced.add(key);
      }
    }
    return referenced;
  });
}

export const sheetReconcileService = {
  /**
   * Delete `imports/` objects that no `imports` row names and that are older
   * than the grace window, within {@link SHEET_LIST_BUDGET}. Returns the number
   * deleted; 0 on an abort.
   *
   * @param bucket the `SHEETS` binding. Absent: no-op.
   * @param now    the clock the grace window is measured against.
   */
  reconcileOrphans(
    bucket: ReconcilableBucket | undefined,
    now: Date = new Date(),
  ): Effect.Effect<number, R2ReconcileError, DbService> {
    return reconcileOrphanObjects(
      bucket,
      {
        label: "sheets",
        prefix: SHEETS_PREFIX,
        referencedKeys: loadReferencedSheetKeys(),
        budget: SHEET_LIST_BUDGET,
      },
      now,
    ).pipe(Effect.withSpan("cire.sheets.reconcileOrphans"));
  },
};
