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
 * Another holds the run, and emails the operator, while `imports` has fewer
 * than half the rows counted before; the lookup counts them in the same scan
 * that names the keys.
 */
import { imports } from "@cire/db";
import { sql, type SQL } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { r2PositionStore, reconcileOrphanObjects } from "./r2-reconcile";
import type {
  ListLimits,
  NamedKeys,
  PositionBucket,
  R2ReconcileError,
  ReconcilableBucket,
  ReconcilePlan,
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
 * object key, a timestamp, a row count and how many runs a hold has lasted —
 * no guest data.
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
 * One row: how many `imports` rows there are (`n`), and, as a JSON array of
 * four-key arrays, every row that names one of `keys` in any key column
 * (`hits`). One scan does both — D1 reads the whole table, since no index
 * covers these columns — so the count and the names describe the same rows.
 * The list rides as ONE bound parameter, unpacked once by the `listed` CTE,
 * where `jsonEachIn` would bind it once per column it is compared with. A full
 * page of matches is about 270 KB in `hits`, inside D1's 2 MB value limit.
 */
export function namedSheetKeysQuery(keys: ReadonlyArray<string>): SQL {
  const list = JSON.stringify(keys);
  return sql`WITH listed(r2_key) AS (SELECT value FROM json_each(${list}))
    SELECT count(*) AS n,
      json_group_array(json_array(${imports.eventsR2Key}, ${imports.guestsR2Key},
        ${imports.beforeEventsR2Key}, ${imports.beforeGuestsR2Key}))
        FILTER (WHERE ${imports.eventsR2Key} IN listed OR ${imports.guestsR2Key} IN listed
          OR ${imports.beforeEventsR2Key} IN listed OR ${imports.beforeGuestsR2Key} IN listed)
        AS hits
    FROM ${imports}`;
}

/**
 * Of `keys`, every one some `imports` row names in any of its four key columns,
 * and how many `imports` rows there are. Every row names two keys at least
 * (`events_r2_key` and `guests_r2_key` are NOT NULL), so each is a referencing
 * row. A `hits` value that is not an array of key arrays is a defect, which
 * aborts the run.
 */
export function namedSheetKeys(
  keys: ReadonlyArray<string>,
): Effect.Effect<NamedKeys, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db.all<{ n: number; hits: string }>(namedSheetKeysQuery(keys)),
    );
    const parsed: unknown = JSON.parse(rows[0]?.hits ?? "[]");
    if (!Array.isArray(parsed)) throw new Error("imports lookup returned no key list");
    const named = new Set<string>();
    for (const row of parsed) {
      if (!Array.isArray(row)) throw new Error("imports lookup returned a malformed row");
      for (const key of row) {
        if (typeof key === "string" && key) named.add(key);
      }
    }
    return { named, referencingRows: rows[0]?.n ?? 0 };
  });
}

export const sheetReconcileService = {
  /**
   * Delete `imports/` objects that no `imports` row names and that are older
   * than the grace window, walking at most {@link SHEET_LIST_LIMITS} a run from
   * where the last run stopped. Returns the number deleted; 0 on an abort.
   *
   * @param bucket  the `SHEETS` binding. Absent: no-op.
   * @param now     the clock the grace window is measured against.
   * @param options `alertOperator`, told when the run is stopped or held.
   */
  reconcileOrphans(
    bucket: SheetsBucket | undefined,
    now: Date = new Date(),
    options: Pick<ReconcilePlan<DbService>, "alertOperator"> = {},
  ): Effect.Effect<number, R2ReconcileError, DbService> {
    return reconcileOrphanObjects(
      bucket,
      {
        label: "sheets",
        prefix: SHEETS_PREFIX,
        liveSample: liveSheetSample,
        named: namedSheetKeys,
        alertOperator: options.alertOperator,
        budget: bucket && {
          ...SHEET_LIST_LIMITS,
          position: r2PositionStore(bucket, SHEET_POSITION_KEY, "sheets"),
        },
      },
      now,
    ).pipe(Effect.withSpan("cire.sheets.reconcileOrphans"));
  },
};
