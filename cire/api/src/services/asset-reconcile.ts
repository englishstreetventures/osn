/**
 * `cire-assets` orphan reconciliation.
 *
 * Invite images live in the `cire-assets` R2 bucket (binding `ASSETS`), keyed
 * `assets/<weddingId>/<slot>-<uuid>`. They are referenced by
 * `wedding_invite_customisations`' per-slot image keys (hero / story / footer),
 * `events.event_image_key` and `registry_items.image_key`. When a re-upload's or
 * remove's best-effort delete of the superseded object fails, nothing in D1
 * names that object any more and there is no R2 lifecycle rule. The retention
 * sweep never touches `cire-assets` (it keeps the live invite, so those rows
 * survive); this reconciliation closes the gap.
 *
 * The walk and its guards — abort on a failed or empty reference read, the
 * grace window, prefix scoping, the per-run delete cap, the hold when the rows
 * naming images fall by more than half, the listing budget and its position —
 * are {@link reconcileOrphanObjects} in `r2-reconcile.ts`. The live keys are
 * read whole, in one statement, once a run: the sample, the lookup and the row
 * count all come from that one read.
 */
import { events, registryItems, weddingInviteCustomisations } from "@cire/db";
import { sql } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { r2PositionStore, reconcileOrphanObjects } from "./r2-reconcile";
import type {
  ListLimits,
  PositionBucket,
  R2ReconcileError,
  ReconcilableBucket,
} from "./r2-reconcile";

/** R2 key prefix that holds invite images. ONLY keys under this are touched. */
export const ASSETS_PREFIX = "assets/";

/**
 * What one run may list: one full page, plus two calls for pages R2 returns
 * short. The walk resumes where the last run stopped, so a bucket past 1,000
 * objects is covered over several daily runs.
 */
export const ASSET_LIST_LIMITS: ListLimits = { maxObjects: 1_000, maxListCalls: 3 };

/**
 * Where the walk keeps its place: one small JSON object in `cire-assets`,
 * outside `assets/`, so the walk never lists or deletes it. The image routes
 * serve only keys a row names, so it is never served.
 */
export const ASSET_POSITION_KEY = "reconcile/assets-position.json";

/** The `ASSETS` binding as the reconciler uses it. `R2Bucket` satisfies it. */
export type AssetsBucket = ReconcilableBucket & PositionBucket;

/** Every live image key, and how many rows name at least one of them. */
interface ReferencedKeys {
  readonly keys: Set<string>;
  readonly rows: number;
}

/**
 * Build the set of R2 keys that ANY live DB row references — across ALL
 * weddings. The reconciliation only ever deletes keys NOT in this set, so this
 * read is the single source of truth for "what is live". It is also the
 * abort-on-uncertainty signal: a throw here aborts the run, and an empty set
 * leaves no live sample, which aborts it too.
 *
 * One statement of three arms:
 *  - every wedding-level image slot's key (one customisation row per wedding).
 *    It MUST list every column in `INVITE_IMAGE_SLOTS` — a slot missing here is
 *    not a no-op, it is data loss: this set is what marks an object LIVE, so an
 *    unlisted slot's images look orphaned and get swept once past the grace
 *    window. Adding an image slot means adding its key column to the first arm;
 *  - event image keys (one optional per event);
 *  - registry item images (one optional per gift item). These are copies of
 *    shop-page pictures the organiser picked, stored here rather than
 *    hotlinked, so they are live objects like any other, and omitting them
 *    would make the sweep delete every registry image a week after it was saved.
 */
function loadReferencedKeys(): Effect.Effect<ReferencedKeys, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;
    const rows = yield* dbQuery(() =>
      db.all<{ a: string | null; b: string | null; c: string | null }>(sql`
        SELECT ${weddingInviteCustomisations.heroImageKey} AS a,
          ${weddingInviteCustomisations.storyImageKey} AS b,
          ${weddingInviteCustomisations.footerImageKey} AS c
        FROM ${weddingInviteCustomisations}
        UNION ALL
        SELECT ${events.eventImageKey}, NULL, NULL FROM ${events}
        WHERE ${events.eventImageKey} IS NOT NULL
        UNION ALL
        SELECT ${registryItems.imageKey}, NULL, NULL FROM ${registryItems}
        WHERE ${registryItems.imageKey} IS NOT NULL`),
    );

    const keys = new Set<string>();
    // A customisation row with every slot empty names nothing, so it is not a
    // referencing row; the other two arms return only rows with a key.
    let referencing = 0;
    for (const row of rows) {
      let names = false;
      for (const key of [row.a, row.b, row.c]) {
        if (key) {
          keys.add(key);
          names = true;
        }
      }
      if (names) referencing += 1;
    }
    return { keys, rows: referencing };
  });
}

export const assetReconcileService = {
  /**
   * Delete `assets/` objects that no live row references and that are older
   * than the grace window, walking at most {@link ASSET_LIST_LIMITS} a run from
   * where the last run stopped. Returns the number deleted; 0 on an abort.
   *
   * @param bucket the `ASSETS` binding. Absent: no-op.
   * @param now    the clock the grace window is measured against.
   */
  reconcileOrphans(
    bucket: AssetsBucket | undefined,
    now: Date = new Date(),
  ): Effect.Effect<number, R2ReconcileError, DbService> {
    return Effect.gen(function* () {
      const live = yield* Effect.cached(loadReferencedKeys());
      return yield* reconcileOrphanObjects(
        bucket,
        {
          label: "assets",
          prefix: ASSETS_PREFIX,
          liveSample: live.pipe(Effect.map(({ keys }) => keys.values().next().value)),
          // Every live key: it answers for each key the walk asks about.
          named: () =>
            live.pipe(Effect.map(({ keys, rows }) => ({ named: keys, referencingRows: rows }))),
          budget: bucket && {
            ...ASSET_LIST_LIMITS,
            position: r2PositionStore(bucket, ASSET_POSITION_KEY, "assets"),
          },
        },
        now,
      );
    }).pipe(Effect.withSpan("cire.assets.reconcileOrphans"));
  },
};
