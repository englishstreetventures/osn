import { Effect } from "effect";

import { metricR2ObjectsSwept } from "../metrics";

/**
 * Best-effort bulk R2 object reaper, shared by any flow that orphans R2 objects
 * when it deletes the D1 rows that referenced them (today: the guest-data
 * retention sweep; a future organiser wedding-delete flow would call it too).
 *
 * Why a separate helper: cire stores R2 **keys** in D1 (`imports.events_r2_key`
 * / `guests_r2_key` in the `cire-sheets` bucket; `wedding_invite_customisations`
 * hero/story keys + `events.event_image_key` in `cire-assets`). D1's
 * `ON DELETE cascade` fans out *within* D1 but NEVER reaches R2, so deleting a
 * wedding/import row silently orphans its objects (uploaded guest sheets +
 * wedding photos — personal data) forever. The caller collects the keys BEFORE
 * deleting the rows, then hands them here.
 *
 * Contract:
 *  - **Best-effort.** A failed object delete is logged (`Effect.logError`, keys
 *    are non-PII opaque paths — counts + chunk index only, never guest data) and
 *    NEVER aborts the caller's sweep. Orphaning a handful of objects is strictly
 *    better than a stuck retention sweep that leaves a whole cohort's PII in D1.
 *  - **Bounded.** Keys are deduped and chunked so a purge touching many objects
 *    respects the Worker CPU/subrequest budget; each chunk is one `delete([...])`
 *    multi-key call where the binding supports it (Cloudflare R2), falling back
 *    to per-key deletes (the in-memory test stub / any single-key binding).
 *  - **Metric.** Emits the bounded-cardinality `cire.r2.objects.swept` counter
 *    (`bucket` ∈ sheets|assets, `result` ∈ ok|error) — count is the number of
 *    keys in the request, so the sum tracks reclaimed objects per bucket.
 */

/** The two cire R2 buckets, as a bounded label for the swept metric. */
export type R2BucketLabel = "sheets" | "assets";

/**
 * Minimal delete-only R2 surface. Cloudflare's `R2Bucket` satisfies this
 * structurally and additionally accepts `string[]` for a single multi-key
 * delete; the in-memory test stubs implement only the single-key form. We
 * feature-detect the array form at call time so both work.
 */
export interface DeletableBucket {
  delete(keys: string | string[]): Promise<unknown> | unknown;
}

/** Max keys per R2 multi-delete request — R2's documented cap is 1000. */
const CHUNK_SIZE = 1000;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Delete `keys` from `bucket`, best-effort. Resolves successfully even if some
 * (or all) deletes fail — failures are logged and counted, never thrown. Empty
 * / all-null key list is a no-op (no metric, no log). Null/blank keys are
 * filtered out so an unset image column never produces a bogus delete.
 */
export function reapR2Objects(
  bucket: DeletableBucket | undefined,
  label: R2BucketLabel,
  keys: ReadonlyArray<string | null | undefined>,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const present = Array.from(
      new Set(keys.filter((k): k is string => typeof k === "string" && k.length > 0)),
    );
    if (present.length === 0) return;

    // No binding in this deployment (local dev / a misconfigured env): the rows
    // are already gone, so the objects are orphaned regardless — log it and move
    // on rather than failing the sweep.
    if (!bucket) {
      yield* Effect.logWarning("r2 cleanup skipped — bucket binding absent", {
        bucket: label,
        keys: present.length,
      });
      yield* Effect.sync(() => metricR2ObjectsSwept(label, "error", present.length));
      return;
    }

    let reaped = 0;
    let failed = 0;
    const chunks = chunk(present, CHUNK_SIZE);
    for (let i = 0; i < chunks.length; i++) {
      const batch = chunks[i];
      const result = yield* Effect.tryPromise({
        try: async () => {
          // Cloudflare R2's `delete` accepts `string[]` (one multi-key request);
          // the in-memory test stub / any single-key binding may not. Attempt the
          // array form first, fall back to per-key deletes if it throws.
          try {
            await Promise.resolve(bucket.delete(batch));
            return;
          } catch {
            // Binding rejected the array form — fall through to per-key deletes.
          }
          for (const key of batch) {
            // eslint-disable-next-line no-await-in-loop
            await Promise.resolve(bucket.delete(key));
          }
        },
        catch: (cause) => cause,
      }).pipe(
        Effect.as("ok" as const),
        Effect.catchAll((cause) =>
          // Best-effort: a failed chunk is logged (chunk index + size only, no
          // keys/PII) and swallowed so the sweep continues.
          Effect.logError("r2 cleanup chunk failed", {
            bucket: label,
            chunk: i,
            keys: batch.length,
            reason: String(cause),
          }).pipe(Effect.as("error" as const)),
        ),
      );
      if (result === "ok") reaped += batch.length;
      else failed += batch.length;
    }

    if (reaped > 0) yield* Effect.sync(() => metricR2ObjectsSwept(label, "ok", reaped));
    if (failed > 0) yield* Effect.sync(() => metricR2ObjectsSwept(label, "error", failed));
    yield* Effect.logInfo("r2 cleanup complete", { bucket: label, reaped, failed });
  }).pipe(Effect.withSpan("cire.r2.reapObjects"));
}
