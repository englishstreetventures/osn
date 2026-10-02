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
 * "Referenced" is decided per KEY, from the four key columns of `imports`,
 * never per import id: the prune keeps a change's row and NULLs its before
 * keys, so a row can exist while two of its objects are orphans.
 *
 * The walk and its guards are {@link reconcileOrphanObjects} in
 * `r2-reconcile.ts`. An empty `imports` table while sheets exist is one of those
 * guards: the run deletes nothing and logs a warning until any change row exists.
 */
import { imports } from "@cire/db";
import { sql, type SQL } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { r2PositionStore, reconcileOrphanObjects } from "./r2-reconcile";
import type {
  ListLimits,
  PositionBucket,
  R2ReconcileError,
  ReconcilableBucket,
} from "./r2-reconcile";

/** Every sheet object lives under this prefix; nothing else is touched. */
export const SHEETS_PREFIX = "imports/";

/**
 * What one run may list: one full page, plus two calls for pages R2 returns
 * short. Every candidate goes to D1 in one JSON parameter, and 1,000 keys of
 * today's shape (`r2-imports.ts`, at most 62 characters) come to about 65 KB —
 * under D1's 100 KB statement limit even if D1 counts bound values towards it.
 * The walk resumes where the last run stopped, so a bucket past 1,000 objects
 * is covered over several daily runs.
 */
export const SHEET_LIST_LIMITS: ListLimits = { maxObjects: 1_000, maxListCalls: 3 };

/**
 * Where the walk keeps its place: one small JSON object in `cire-sheets`,
 * outside `imports/`, so the walk never lists or deletes it. It holds an
 * object key and a timestamp, no guest data.
 */
export const SHEET_POSITION_KEY = "reconcile/imports-position.json";

/** The `SHEETS` binding as the reconciler uses it. `R2Bucket` satisfies it. */
export type SheetsBucket = ReconcilableBucket & PositionBucket;

/** The events-sheet key of any one `imports` row; undefined when there is none. */
const liveSheetSample: Effect.Effect<string | undefined, never, DbService> = Effect.gen(
  function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db.select({ key: imports.eventsR2Key }).from(imports).limit(1).all(),
    );
    return rows[0]?.key;
  },
);

/**
 * The four key columns of every `imports` row that names one of `keys`. The
 * list rides as ONE bound parameter, unpacked once by the `listed` CTE, where
 * `jsonEachIn` would bind it once per column it is compared with. D1 still
 * reads the whole table — no index covers these columns — but returns only the
 * rows that match.
 */
export function namedSheetKeysQuery(keys: ReadonlyArray<string>): SQL {
  const list = JSON.stringify(keys);
  return sql`WITH listed(r2_key) AS (SELECT value FROM json_each(${list}))
    SELECT ${imports.eventsR2Key} AS e, ${imports.guestsR2Key} AS g,
      ${imports.beforeEventsR2Key} AS be, ${imports.beforeGuestsR2Key} AS bg
    FROM ${imports}
    WHERE ${imports.eventsR2Key} IN listed OR ${imports.guestsR2Key} IN listed
      OR ${imports.beforeEventsR2Key} IN listed OR ${imports.beforeGuestsR2Key} IN listed`;
}

/** Of `keys`, every one some `imports` row names in any of its four key columns. */
export function namedSheetKeys(
  keys: ReadonlyArray<string>,
): Effect.Effect<Set<string>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db.all<{ e: string; g: string; be: string | null; bg: string | null }>(
        namedSheetKeysQuery(keys),
      ),
    );
    const named = new Set<string>();
    for (const row of rows) {
      for (const key of [row.e, row.g, row.be, row.bg]) {
        if (key) named.add(key);
      }
    }
    return named;
  });
}

export const sheetReconcileService = {
  /**
   * Delete `imports/` objects that no `imports` row names and that are older
   * than the grace window, walking at most {@link SHEET_LIST_LIMITS} a run from
   * where the last run stopped. Returns the number deleted; 0 on an abort.
   *
   * @param bucket the `SHEETS` binding. Absent: no-op.
   * @param now    the clock the grace window is measured against.
   */
  reconcileOrphans(
    bucket: SheetsBucket | undefined,
    now: Date = new Date(),
  ): Effect.Effect<number, R2ReconcileError, DbService> {
    return reconcileOrphanObjects(
      bucket,
      {
        label: "sheets",
        prefix: SHEETS_PREFIX,
        liveSample: liveSheetSample,
        named: namedSheetKeys,
        budget: bucket && {
          ...SHEET_LIST_LIMITS,
          position: r2PositionStore(bucket, SHEET_POSITION_KEY, "sheets"),
        },
      },
      now,
    ).pipe(Effect.withSpan("cire.sheets.reconcileOrphans"));
  },
};
