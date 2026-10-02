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
 * The walk and its guards — abort on a failed or empty referenced-key read, the
 * grace window, prefix scoping, the per-run delete cap — are
 * {@link reconcileOrphanObjects} in `r2-reconcile.ts`. This bucket is walked
 * whole every run, with no listing budget.
 */
import { events, registryItems, weddingInviteCustomisations } from "@cire/db";
import { isNotNull } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import { reconcileOrphanObjects } from "./r2-reconcile";
import type { R2ReconcileError, ReconcilableBucket } from "./r2-reconcile";

/** R2 key prefix that holds invite images. ONLY keys under this are touched. */
export const ASSETS_PREFIX = "assets/";

/**
 * Build the set of R2 keys that ANY live DB row references — across ALL
 * weddings. The reconciliation only ever deletes keys NOT in this set, so this
 * read is the single source of truth for "what is live". It is also the
 * abort-on-uncertainty signal: a throw here (caught by the caller) aborts the
 * whole run.
 */
function loadReferencedKeys(): Effect.Effect<Set<string>, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    // Every wedding-level image slot's key (one customisation row per wedding).
    // MUST list every column in `INVITE_IMAGE_SLOTS` — a slot missing here is
    // not a no-op, it is data loss: this set is what marks an object LIVE, so an
    // unlisted slot's images look orphaned and get swept once past the grace
    // window. Adding an image slot means adding its key column here.
    const custRows = yield* dbQuery(() =>
      db
        .select({
          hero: weddingInviteCustomisations.heroImageKey,
          story: weddingInviteCustomisations.storyImageKey,
          footer: weddingInviteCustomisations.footerImageKey,
        })
        .from(weddingInviteCustomisations)
        .all(),
    );

    // event image keys (one optional per event). Filter to non-null in SQL.
    const eventRows = yield* dbQuery(() =>
      db
        .select({ key: events.eventImageKey })
        .from(events)
        .where(isNotNull(events.eventImageKey))
        .all(),
    );

    // Registry item images (one optional per gift item). These are copies of
    // shop-page pictures the organiser picked, stored here rather than hotlinked
    // — so they are live objects like any other, and omitting them would make the
    // sweep delete every registry image a week after it was saved.
    const registryRows = yield* dbQuery(() =>
      db
        .select({ key: registryItems.imageKey })
        .from(registryItems)
        .where(isNotNull(registryItems.imageKey))
        .all(),
    );

    const referenced = new Set<string>();
    for (const r of custRows) {
      // Iterate the row's values rather than naming each slot again — one place
      // to update (the select above) instead of two that can drift apart.
      for (const key of Object.values(r)) {
        if (key) referenced.add(key);
      }
    }
    for (const r of eventRows) {
      if (r.key) referenced.add(r.key);
    }
    for (const r of registryRows) {
      if (r.key) referenced.add(r.key);
    }
    return referenced;
  });
}

export const assetReconcileService = {
  /**
   * Delete `assets/` objects that no live row references and that are older
   * than the grace window. Returns the number deleted; 0 on an abort.
   *
   * @param bucket the `ASSETS` binding. Absent: no-op.
   * @param now    the clock the grace window is measured against.
   */
  reconcileOrphans(
    bucket: ReconcilableBucket | undefined,
    now: Date = new Date(),
  ): Effect.Effect<number, R2ReconcileError, DbService> {
    return reconcileOrphanObjects(
      bucket,
      { label: "assets", prefix: ASSETS_PREFIX, referencedKeys: loadReferencedKeys() },
      now,
    ).pipe(Effect.withSpan("cire.assets.reconcileOrphans"));
  },
};
