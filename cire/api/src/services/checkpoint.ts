import { imports } from "@cire/db";
import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { Effect } from "effect";

import { DbService, dbQuery } from "../db";
import type { DeletableBucket } from "./r2-cleanup";
import { reapR2Objects } from "./r2-cleanup";
import { R2Service, storeBeforeImage } from "./r2-imports";
import type { R2Error } from "./r2-imports";
import { stateExportService } from "./state-export";

/**
 * Change-history checkpointing (guest+event editor E3, [[guest-event-editor]]
 * §4). Two operations run at apply time, BEFORE the change mutates the DB:
 *
 *  1. {@link captureBeforeImage} — serialise the wedding's CURRENT state to the
 *     canonical snapshot CSVs at FULL fidelity (`state-export.ts`, so the CSVs
 *     carry `Family Code`/`Family ID`/`Guest ID`/`Event ID` and provenance), and
 *     store them in R2 as this change's before-image. Revert restores exactly
 *     these CSVs, so codes + ids survive (rename-proof, no re-mint).
 *
 *  2. {@link pruneBeforeImages} — cap retained before-images at the most recent
 *     10 changes per wedding. Older changes keep their history ROW (the list
 *     stays complete) but lose their R2 before-image and thus their
 *     revertability (E6 surfaces this in the UI). Reuses the shared
 *     best-effort R2 reaper (`r2-cleanup.ts`).
 */

/** Retained before-images per wedding. Decided in [[guest-event-editor]] §4/§11:
 *  snapshots are small text objects, but unbounded per-save growth needs a Free-
 *  tier cap. The history rows all survive; only stale R2 before-images age out. */
export const BEFORE_IMAGE_RETENTION = 10;

/**
 * Serialise the wedding's current state at FULL fidelity and store it as the
 * before-image for `importId`, returning the two R2 keys to record on the change
 * row. Runs at apply time BEFORE the write set commits — the snapshot must
 * capture the pre-change state.
 */
export function captureBeforeImage(
  importId: string,
  weddingId: string,
): Effect.Effect<{ eventsKey: string; guestsKey: string }, R2Error, DbService | R2Service> {
  return Effect.gen(function* () {
    // Full fidelity: `Family Code` (publicId → codes restored, not re-minted),
    // `Family ID`/`Guest ID`/`Event ID` (id-exact, rename-proof restore), and
    // `Source` provenance survive the round trip.
    const eventsCsv = yield* stateExportService.eventsCsv(weddingId, "full");
    const guestsCsv = yield* stateExportService.guestsCsv(weddingId, "full");
    return yield* storeBeforeImage(eventsCsv, guestsCsv, importId);
  }).pipe(Effect.withSpan("cire.checkpoint.captureBeforeImage"));
}

/**
 * Prune before-images beyond the {@link BEFORE_IMAGE_RETENTION} most-recent
 * changes for `weddingId`. For every stale change that still HAS a before-image:
 * best-effort delete its two R2 objects, then NULL its before-keys so the row
 * (which stays in the history) is correctly marked non-revertable-via-before-
 * image. Never throws — a reap failure is logged + counted (see
 * {@link reapR2Objects}); the D1 NULL-out still happens so the row's state is
 * honest even if the objects orphan.
 *
 * `bucket` is the `cire-sheets` binding (`SHEETS`). When absent (local/dev) the
 * reaper logs + counts as orphaned and we still NULL the keys.
 */
export function pruneBeforeImages(
  weddingId: string,
  bucket: DeletableBucket | undefined,
): Effect.Effect<void, never, DbService> {
  return Effect.gen(function* () {
    const db = yield* DbService;

    // Every change with a before-image, newest first. The composite
    // (wedding_id, uploaded_at) index serves the scope + order; `isNotNull`
    // is a residual filter.
    const withImage = yield* dbQuery(() =>
      db
        .select({
          id: imports.id,
          beforeEventsR2Key: imports.beforeEventsR2Key,
          beforeGuestsR2Key: imports.beforeGuestsR2Key,
        })
        .from(imports)
        .where(and(eq(imports.weddingId, weddingId), isNotNull(imports.beforeEventsR2Key)))
        .orderBy(desc(imports.uploadedAt))
        .all(),
    );

    const stale = withImage.slice(BEFORE_IMAGE_RETENTION);
    if (stale.length === 0) return;

    const keys = stale.flatMap((r) => [r.beforeEventsR2Key, r.beforeGuestsR2Key]);
    // Best-effort reap first (keys collected above are unrecoverable once NULLed).
    yield* reapR2Objects(bucket, "sheets", keys);

    // NULL the before-keys so the rows read as non-revertable (row itself stays).
    yield* dbQuery(() =>
      db
        .update(imports)
        .set({ beforeEventsR2Key: null, beforeGuestsR2Key: null })
        .where(
          inArray(
            imports.id,
            stale.map((r) => r.id),
          ),
        )
        .run(),
    );

    yield* Effect.logInfo("before-image prune complete", {
      wedding: weddingId,
      pruned: stale.length,
    });
  }).pipe(Effect.withSpan("cire.checkpoint.pruneBeforeImages"));
}
